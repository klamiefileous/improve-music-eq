from __future__ import annotations

import logging
import math
import re
import shutil
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import numpy as np
import soundfile as sf
import soxr
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pedalboard import (
    Compressor,
    HighShelfFilter,
    LowShelfFilter,
    Pedalboard,
    PeakFilter,
    Reverb,
)
from pedalboard.io import AudioFile
from pydantic import BaseModel, Field, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_DURATION_SECONDS = 45 * 60
CHUNK_FRAMES = 65536
EXPORT_TTL_SECONDS = 60 * 60
MAX_EXPORTS = 200
logger = logging.getLogger("afterglow")
logger.setLevel(logging.INFO)

export_directory = Path(tempfile.mkdtemp(prefix="afterglow-exports-"))
exports: dict[str, tuple[Path, str, float]] = {}
exports_lock = threading.Lock()
processing_slot = threading.BoundedSemaphore(1)


class EqBand(BaseModel):
    frequency: float = Field(ge=20, le=20000)
    q: float = Field(ge=0.1, le=10)
    gain: float = Field(ge=-12, le=12)


class ExportParameters(BaseModel):
    eq: list[EqBand] = Field(min_length=4, max_length=4)
    reverb: float = Field(ge=0, le=0.3)
    decay: float = Field(ge=0.5, le=4)
    width: float = Field(ge=0.7, le=1.3)
    threshold: float = Field(ge=-36, le=-6)
    normalize: bool
    sampleRate: int = Field(ge=44100, le=48000)

    @field_validator("sampleRate")
    @classmethod
    def validate_sample_rate(cls, value: int) -> int:
        if value not in (44100, 48000):
            raise ValueError("采样率仅支持 44.1 kHz 或 48 kHz。")
        return value

    def validate_audio_sample_rate(self) -> None:
        if any(band.frequency >= self.sampleRate / 2 for band in self.eq):
            raise ValueError("EQ 频率必须低于导出采样率的奈奎斯特频率。")


def cleanup_expired_exports() -> None:
    now = time.time()
    expired: list[Path] = []
    with exports_lock:
        for export_id, (path, _, expires_at) in list(exports.items()):
            if expires_at <= now:
                expired.append(path)
                del exports[export_id]
    for path in expired:
        path.unlink(missing_ok=True)


def make_board(parameters: ExportParameters, sample_rate: int, channels: int) -> Pedalboard:
    low, low_mid, high_mid, air = parameters.eq
    effects = [
        LowShelfFilter(
            cutoff_frequency_hz=min(low.frequency, sample_rate * 0.45),
            gain_db=low.gain,
            q=low.q,
        ),
        PeakFilter(
            cutoff_frequency_hz=min(low_mid.frequency, sample_rate * 0.45),
            gain_db=low_mid.gain,
            q=low_mid.q,
        ),
        PeakFilter(
            cutoff_frequency_hz=min(high_mid.frequency, sample_rate * 0.45),
            gain_db=high_mid.gain,
            q=high_mid.q,
        ),
        HighShelfFilter(
            cutoff_frequency_hz=min(air.frequency, sample_rate * 0.45),
            gain_db=air.gain,
            q=air.q,
        ),
        Reverb(
            room_size=min(0.2 + parameters.decay * 0.18, 0.92),
            damping=0.45,
            wet_level=parameters.reverb,
            dry_level=1.0,
            width=1.0,
        ),
        Compressor(
            threshold_db=parameters.threshold,
            ratio=2.2,
            attack_ms=8,
            release_ms=180,
        ),
    ]
    return Pedalboard(effects)


def render_audio(
    input_path: Path,
    output_path: Path,
    parameters: ExportParameters,
) -> tuple[int, float]:
    with AudioFile(str(input_path), "r") as source:
        input_rate = source.samplerate
        channels = source.num_channels
        duration = source.duration
        if channels not in (1, 2):
            raise ValueError("目前仅支持单声道或立体声音频。")
        if not math.isfinite(duration) or duration <= 0 or duration > MAX_DURATION_SECONDS:
            raise ValueError("音频时长无效或超过 45 分钟处理上限。")
        parameters.validate_audio_sample_rate()
        board = make_board(parameters, parameters.sampleRate, channels)
        resampler = (
            soxr.ResampleStream(input_rate, parameters.sampleRate, channels, dtype="float32", quality="HQ")
            if input_rate != parameters.sampleRate
            else None
        )
        total_frames = 0
        peak = 0.0

        with tempfile.NamedTemporaryFile(
            prefix="afterglow-render-",
            suffix=".wav",
            dir=export_directory,
            delete=False,
        ) as intermediate_file:
            intermediate_path = Path(intermediate_file.name)

        try:
            with sf.SoundFile(
                intermediate_path,
                mode="w",
                samplerate=parameters.sampleRate,
                channels=channels,
                subtype="FLOAT",
                format="WAV",
            ) as intermediate:
                while True:
                    block = source.read(CHUNK_FRAMES)
                    if block.shape[1] == 0:
                        break
                    frames_channels = block.T
                    if resampler:
                        frames_channels = resampler.resample_chunk(frames_channels)
                    if frames_channels.shape[0] == 0:
                        continue
                    processed = board(frames_channels.T, parameters.sampleRate, reset=False)
                    if channels == 2 and parameters.width != 1:
                        processed = apply_stereo_width(processed, parameters.width)
                    total_frames += processed.shape[1]
                    peak = max(peak, float(np.max(np.abs(processed))))
                    intermediate.write(processed.T)

                if resampler:
                    flushed = resampler.resample_chunk(
                        np.empty((0, channels), dtype=np.float32),
                        last=True,
                    )
                    if flushed.shape[0]:
                        processed = board(flushed.T, parameters.sampleRate, reset=False)
                        if channels == 2 and parameters.width != 1:
                            processed = apply_stereo_width(processed, parameters.width)
                        total_frames += processed.shape[1]
                        peak = max(peak, float(np.max(np.abs(processed))))
                        intermediate.write(processed.T)

                tail_frames = round(parameters.decay * parameters.sampleRate) if parameters.reverb > 0 else 0
                if tail_frames:
                    remaining = tail_frames
                    while remaining:
                        frames = min(CHUNK_FRAMES, remaining)
                        tail = board(
                            np.zeros((channels, frames), dtype=np.float32),
                            parameters.sampleRate,
                            reset=False,
                        )
                        if channels == 2 and parameters.width != 1:
                            tail = apply_stereo_width(tail, parameters.width)
                        total_frames += tail.shape[1]
                        peak = max(peak, float(np.max(np.abs(tail))))
                        intermediate.write(tail.T)
                        remaining -= frames
        except Exception:
            intermediate_path.unlink(missing_ok=True)
            raise

    gain = 1.0
    if parameters.normalize and peak > 0:
        gain = 10 ** (-1 / 20) / peak

    try:
        with sf.SoundFile(intermediate_path, mode="r") as intermediate, sf.SoundFile(
            output_path,
            mode="w",
            samplerate=parameters.sampleRate,
            channels=channels,
            subtype="PCM_24",
            format="WAV",
        ) as output:
            while True:
                block = intermediate.read(CHUNK_FRAMES, dtype="float32", always_2d=True)
                if block.shape[0] == 0:
                    break
                output.write(np.clip(block * gain, -1.0, 1.0))
    finally:
        intermediate_path.unlink(missing_ok=True)
    return parameters.sampleRate, total_frames / parameters.sampleRate


def apply_stereo_width(audio: np.ndarray, width: float) -> np.ndarray:
    mid = (audio[0] + audio[1]) * 0.5
    side = (audio[0] - audio[1]) * (0.5 * width)
    return np.stack((mid + side, mid - side))


async def save_upload(upload: UploadFile, destination: Path) -> None:
    total_bytes = 0
    try:
        with destination.open("wb") as output:
            while chunk := await upload.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="单个音频文件最大支持 500 MB。")
                output.write(chunk)
    finally:
        await upload.close()
    if total_bytes == 0:
        raise HTTPException(status_code=400, detail="上传的音频文件为空。")


def safe_output_name(filename: str | None) -> str:
    original = Path(filename or "track").name
    stem = Path(original).stem.strip()
    cleaned = "".join(char if char.isalnum() or char in " ._-" else "_" for char in stem)
    return f"{cleaned[:120] or 'track'}-afterglow.wav"


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    shutil.rmtree(export_directory, ignore_errors=True)


app = FastAPI(
    title="Afterglow Studio",
    description="Local audio export API",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/exports")
async def create_export(
    audio: Annotated[UploadFile, File()],
    parameters: Annotated[str, Form()],
) -> dict[str, str | int | float]:
    cleanup_expired_exports()
    if not processing_slot.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="已有曲目正在处理，请稍后重试。")

    try:
        try:
            settings = ExportParameters.model_validate_json(parameters)
        except ValidationError as error:
            await audio.close()
            errors = error.errors(include_input=False, include_context=False, include_url=False)
            raise HTTPException(status_code=422, detail=errors) from error

        with tempfile.TemporaryDirectory(prefix="afterglow-upload-") as work_dir:
            suffix = Path(audio.filename or "").suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
                suffix = ""
            input_path = Path(work_dir) / f"source-audio{suffix}"
            await save_upload(audio, input_path)
            export_id = uuid.uuid4().hex
            output_path = export_directory / f"{export_id}.wav"
            try:
                sample_rate, duration = await run_in_threadpool(
                    render_audio,
                    input_path,
                    output_path,
                    settings,
                )
            except (ValueError, RuntimeError) as error:
                output_path.unlink(missing_ok=True)
                raise HTTPException(status_code=422, detail=str(error)) from error
            except Exception as error:
                output_path.unlink(missing_ok=True)
                logger.exception("Audio export failed.")
                raise HTTPException(
                    status_code=422,
                    detail="无法解码或处理该音频。请确认文件完整，并尝试 WAV、FLAC、MP3 或 M4A 格式。",
                ) from error

            filename = safe_output_name(audio.filename)
            with exports_lock:
                if len(exports) >= MAX_EXPORTS:
                    oldest_id = min(exports, key=lambda item: exports[item][2])
                    expired_path, _, _ = exports.pop(oldest_id)
                    expired_path.unlink(missing_ok=True)
                exports[export_id] = (output_path, filename, time.time() + EXPORT_TTL_SECONDS)
            return {
                "download_url": f"/api/exports/{export_id}/download",
                "filename": filename,
                "sample_rate": sample_rate,
                "duration_seconds": round(duration, 2),
            }
    finally:
        processing_slot.release()


@app.get("/api/exports/{export_id}/download")
async def download_export(export_id: str) -> FileResponse:
    cleanup_expired_exports()
    with exports_lock:
        export = exports.get(export_id)
    if export is None:
        raise HTTPException(status_code=404, detail="下载链接已过期或不存在，请重新导出。")

    path, filename, _ = export
    if not path.is_file():
        with exports_lock:
            exports.pop(export_id, None)
        raise HTTPException(status_code=404, detail="导出的文件已不可用，请重新导出。")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=filename,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/", include_in_schema=False)
async def home() -> FileResponse:
    return FileResponse(ROOT / "index.html", media_type="text/html")


@app.get("/{asset_name}", include_in_schema=False)
async def frontend_asset(asset_name: str) -> FileResponse:
    if asset_name not in {"app.js", "styles.css"}:
        raise HTTPException(status_code=404, detail="Not found")
    media_type = "text/javascript" if asset_name == "app.js" else "text/css"
    return FileResponse(ROOT / asset_name, media_type=media_type)

"""
Compare audeering vs emotion2vec+ on a folder of audio samples.

For each file: resample to 16kHz mono int16 PCM, stream in 1-second
chunks to BOTH Modal WS endpoints, collect per-window predictions,
aggregate (mode label across windows + mean intensity), print a table.

The folder's filenames are the expected labels: joy.m4a, sadness.wav,
trust.mp3, etc. File stem (without extension) is taken as the
ground-truth label.

Usage
-----
    pip install librosa websockets numpy
    python scripts/compare_emotion_models.py ../test-voice

The audeering endpoint outputs Plutchik 8-class directly; emotion2vec+
outputs a 9-class set (happy/sad/angry/fearful/disgusted/surprised/
neutral/other/unknown) which we map to Plutchik for a fair compare.
"""

import asyncio
import json
import sys
from collections import Counter
from pathlib import Path


AUDEERING_WS    = "wss://gokhan--ojaq-emotion-emotionclassifier-web.modal.run/ws"
EMOTION2VEC_WS  = "wss://gokhan--ojaq-emotion2vec-emotion2vecclassifier-web.modal.run/ws"
HUME_WS         = "wss://api.hume.ai/v0/stream/models"

# Hume's prosody model returns 48 emotion scores per prediction. Group
# them under Plutchik 8 + neutral so the comparison line up.
HUME_TO_PLUTCHIK = {
    # joy cluster
    "Joy": "joy", "Ecstasy": "joy", "Excitement": "joy",
    "Amusement": "joy", "Triumph": "joy", "Pride": "joy",
    # trust cluster (calm-positive)
    "Calmness": "trust", "Contentment": "trust", "Love": "trust",
    "Adoration": "trust", "Sympathy": "trust", "Relief": "trust",
    "Romance": "trust", "Satisfaction": "trust",
    # anticipation cluster (engaged forward)
    "Determination": "anticipation", "Interest": "anticipation",
    "Concentration": "anticipation", "Contemplation": "anticipation",
    "Desire": "anticipation", "Craving": "anticipation",
    "Entrancement": "anticipation", "Admiration": "anticipation",
    "Aesthetic Appreciation": "anticipation",
    # surprise cluster
    "Surprise (positive)": "surprise", "Surprise (negative)": "surprise",
    "Realization": "surprise", "Awe": "surprise",
    # sadness cluster
    "Sadness": "sadness", "Disappointment": "sadness", "Pain": "sadness",
    "Empathic Pain": "sadness", "Nostalgia": "sadness", "Guilt": "sadness",
    # disgust cluster
    "Disgust": "disgust", "Contempt": "disgust", "Shame": "disgust",
    "Embarrassment": "disgust", "Awkwardness": "disgust", "Envy": "disgust",
    # fear cluster
    "Fear": "fear", "Anxiety": "fear", "Horror": "fear",
    "Distress": "fear", "Doubt": "fear",
    # anger cluster
    "Anger": "anger",
    # neutral / no signal
    "Boredom": "neutral", "Tiredness": "neutral", "Confusion": "neutral",
}

# Map emotion2vec+'s 9-class output → Plutchik 8 (+ neutral) so the
# comparison reads side by side. "other" / "unknown" collapse to neutral.
# Chinese aliases included since the model emits either based on revision.
PLUTCHIK_FROM_E2V = {
    "happy":     "joy",
    "sad":       "sadness",
    "angry":     "anger",
    "fearful":   "fear",
    "disgusted": "disgust",
    "surprised": "surprise",
    "neutral":   "neutral",
    "other":     "neutral",
    "unknown":   "neutral",
    # Chinese forms emitted by some emotion2vec_plus revisions
    "中立": "neutral", "中性": "neutral",
    "生气": "anger",
    "开心": "joy", "高兴": "joy",
    "难过": "sadness", "悲伤": "sadness",
    "厌恶": "disgust",
    "恐惧": "fear", "害怕": "fear",
    "吃惊": "surprise", "惊讶": "surprise",
    "其他": "neutral",
    "未知": "neutral",
}

# Labels we drop when re-ranking emotion2vec+ — these soak up confidence
# on naturalistic speech and obscure the actual signal in 2nd-place labels.
E2V_DROP_LABELS = {
    "neutral", "中立", "中性", "other", "其他", "unknown", "未知",
}


def _e2v_rerank(scores: dict):
    """Drop neutral/other/unknown from scores dict, return (top_label, score).
    Falls back to neutral if everything is filtered out."""
    if not scores:
        return None, 0.0
    filtered = {k: v for k, v in scores.items() if k not in E2V_DROP_LABELS}
    if not filtered:
        return "neutral", 0.0
    top_label = max(filtered, key=filtered.get)
    return top_label, float(filtered[top_label])


def _audeering_remap(arousal: float, valence: float, dominance: float,
                     valence_center: float = 0.4):
    """Re-derive Plutchik label from raw A/V/D with valence center shifted
    from 0.5 to ~0.4 — the audeering model reads systematically pessimistic
    valence on naturalistic speech (observed: joy=0.43, even neutral=0.38),
    so the original 0.5 center pushed everything into negative quadrants."""
    da = arousal - 0.5
    dv = valence - valence_center
    dd = dominance - 0.5
    intensity = min(1.0, ((da * da) + (dv * dv)) ** 0.5 * 1.6)

    if intensity < 0.15:
        return "neutral", intensity
    if da > 0.12 and dv > 0.12:
        return ("anticipation" if dd > 0.10 else "joy"), intensity
    if da < -0.05 and dv > 0.12:
        return "trust", intensity
    if da > 0.12 and dv < -0.10:
        return ("anger" if dd > 0.05 else "fear"), intensity
    if da > 0.30 and abs(dv) < 0.12:
        return "surprise", intensity
    if da < -0.05 and dv < -0.12:
        return "sadness", intensity
    if abs(da) < 0.20 and dv < -0.10 and dd > 0.10:
        return "disgust", intensity
    # Fallback: nearest cardinal quadrant
    if dv >= 0:
        return ("joy" if da >= 0 else "trust"), intensity
    return ("anger" if da >= 0 else "sadness"), intensity


def _load_audio_int16(path: Path, target_rms_db: float = -20.0):
    """Load any audio file → 16kHz mono int16 PCM bytes, RMS-normalized
    to ~target_rms_db so quiet phone recordings don't read as silence.

    Phone/laptop recordings often land at -40 to -50 dBFS RMS while SER
    models are trained on speech around -20 dBFS. Without normalization
    they classify near-silence (neutral/sadness/low-arousal default).
    """
    import subprocess
    import imageio_ffmpeg
    import numpy as np
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg, "-loglevel", "error", "-i", str(path),
        "-f", "s16le", "-ar", "16000", "-ac", "1", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=True)
    arr = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    duration = len(arr) / 16000.0

    # RMS normalize, but cap gain so we don't clip
    rms = float(np.sqrt(np.mean(arr * arr)))
    target_rms = 10 ** (target_rms_db / 20)  # ~0.1 for -20dBFS
    if rms > 1e-6:
        gain = target_rms / rms
        peak = float(np.max(np.abs(arr)))
        max_gain = (0.95 / peak) if peak > 0 else gain
        gain = min(gain, max_gain)
        arr = arr * gain
        rms_after = 20 * np.log10(max(np.sqrt(np.mean(arr * arr)), 1e-9))
        print(f"  normalized: rms {20*np.log10(max(rms,1e-9)):.1f}dB -> {rms_after:.1f}dB (gain {20*np.log10(gain):.1f}dB)")

    int16 = (arr * 32767.0).clip(-32768, 32767).astype(np.int16)
    return int16.tobytes(), duration


def _pcm_to_wav_bytes(pcm: bytes, sr: int = 16000) -> bytes:
    """Wrap raw int16 mono PCM into a WAV container so APIs that expect
    a file format (Hume) can consume it directly."""
    import io, wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # int16
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


async def _stream_hume(audio_pcm: bytes, api_key: str, chunk_seconds: int = 5):
    """Stream audio to Hume's prosody model via their streaming WS,
    return list of per-chunk responses (each containing emotion scores)."""
    import base64
    import websockets
    if not api_key:
        return []
    chunk_bytes = chunk_seconds * 16000 * 2  # int16
    responses = []
    headers = {"X-Hume-Api-Key": api_key}
    try:
        async with websockets.connect(
            HUME_WS, additional_headers=headers,
            max_size=None, open_timeout=60,
        ) as ws:
            for i in range(0, len(audio_pcm), chunk_bytes):
                pcm_chunk = audio_pcm[i:i + chunk_bytes]
                if len(pcm_chunk) < 16000 * 2:  # skip <1s tail
                    break
                wav = _pcm_to_wav_bytes(pcm_chunk)
                await ws.send(json.dumps({
                    "models": {"prosody": {}},
                    "data": base64.b64encode(wav).decode(),
                }))
                msg = await asyncio.wait_for(ws.recv(), timeout=30.0)
                responses.append(json.loads(msg))
    except Exception as e:
        print(f"  [error] hume: {type(e).__name__}: {e}")
    return responses


def _hume_aggregate(responses, top_n_emotions: int = 1):
    """Hume returns 48 emotion scores per prediction. For each prediction,
    pick the SINGLE highest-scoring fine-grained emotion, then map that
    emotion to its Plutchik bucket. Take mode (most-common bucket) across
    predictions. This avoids the bucket-size bias of summing within
    buckets — the 'anticipation' bucket happens to contain 9 fine-grained
    emotions vs 6 for 'joy', so summing favors the larger cluster
    regardless of actual signal."""
    if not responses:
        return None, 0.0, 0
    chunk_buckets = []          # one Plutchik label per prediction
    chunk_top_scores = {}        # per-bucket sum of top-emotion scores
    bucket_counts = {}
    top_emotions_log = []        # (chunk_idx, top_emotion_name, score)
    chunk_idx = 0
    for resp in responses:
        prosody = resp.get("prosody", {})
        for pred in prosody.get("predictions", []) or []:
            emotions = pred.get("emotions", [])
            if not emotions:
                continue
            top = max(emotions, key=lambda e: float(e.get("score", 0)))
            top_name = top.get("name", "")
            top_score = float(top.get("score", 0))
            bucket = HUME_TO_PLUTCHIK.get(top_name, "neutral")
            chunk_buckets.append(bucket)
            chunk_top_scores.setdefault(bucket, []).append(top_score)
            bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1
            top_emotions_log.append((chunk_idx, top_name, top_score, bucket))
            chunk_idx += 1
    if not chunk_buckets:
        return None, 0.0, 0
    # Mode bucket
    mode_bucket = Counter(chunk_buckets).most_common(1)[0][0]
    scores = chunk_top_scores.get(mode_bucket, [])
    mean_score = sum(scores) / len(scores) if scores else 0.0
    # Stash per-chunk for debug printing
    _hume_aggregate.last_log = top_emotions_log
    return mode_bucket, float(mean_score), len(chunk_buckets)


_hume_aggregate.last_log = []


async def _stream(audio_bytes: bytes, url: str, label: str):
    """Stream audio to a WS endpoint in 1-second chunks, collect responses."""
    import websockets
    responses = []
    chunk_size = 16000 * 2   # 1.0s of int16 = 32000 bytes
    try:
        async with websockets.connect(url, max_size=None, open_timeout=60) as ws:
            # Send all chunks back-to-back
            for i in range(0, len(audio_bytes), chunk_size):
                await ws.send(audio_bytes[i:i + chunk_size])
            # Drain remaining predictions (server may emit a few more after we finish sending)
            try:
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=4.0)
                    responses.append(json.loads(msg))
            except asyncio.TimeoutError:
                pass
    except Exception as e:
        print(f"  [error] {label}: {type(e).__name__}: {e}")
    return responses


def _aggregate(responses):
    """Most-common emotion across windows + mean intensity for that label."""
    if not responses:
        return None, 0.0, 0
    labels = [r.get("emotion") for r in responses if r.get("emotion")]
    if not labels:
        return None, 0.0, 0
    top_label = Counter(labels).most_common(1)[0][0]
    intensities = [r["intensity"] for r in responses if r.get("emotion") == top_label]
    mean_intensity = sum(intensities) / len(intensities) if intensities else 0.0
    return top_label, mean_intensity, len(responses)


def _aggregate_audeering_remapped(responses):
    """Same as _aggregate but re-derives the Plutchik label per window
    from raw A/V/D using valence_center=0.4 (calibration shift)."""
    if not responses:
        return None, 0.0, 0
    labels_intensities = [
        _audeering_remap(r.get("arousal", 0.5), r.get("valence", 0.5), r.get("dominance", 0.5))
        for r in responses
    ]
    labels = [li[0] for li in labels_intensities]
    top_label = Counter(labels).most_common(1)[0][0]
    matching = [li[1] for li in labels_intensities if li[0] == top_label]
    mean_intensity = sum(matching) / len(matching) if matching else 0.0
    return top_label, mean_intensity, len(responses)


def _aggregate_e2v_reranked(responses):
    """Same as _aggregate but re-ranks per-window scores by dropping
    neutral/other/unknown, then takes the top remaining label."""
    if not responses:
        return None, 0.0, 0
    labels_intensities = [_e2v_rerank(r.get("scores") or {}) for r in responses]
    labels = [li[0] for li in labels_intensities if li[0]]
    if not labels:
        return None, 0.0, 0
    top_label = Counter(labels).most_common(1)[0][0]
    matching = [li[1] for li in labels_intensities if li[0] == top_label]
    mean_intensity = sum(matching) / len(matching) if matching else 0.0
    return top_label, mean_intensity, len(responses)


async def _test_file(path: Path, expected: str):
    print(f"\n--- {path.name} (expected: {expected}) ---")
    try:
        audio_bytes, duration = _load_audio_int16(path)
    except Exception as e:
        print(f"  load failed: {type(e).__name__}: {e}")
        return (path.name, expected, None, 0.0, 0, None, 0.0, 0)
    print(f"  duration: {duration:.1f}s")

    # Run the two endpoints concurrently to halve wall-clock time
    import os
    hume_key = os.getenv("HUME_API_KEY", "")
    aud_resp, e2v_resp, hume_resp = await asyncio.gather(
        _stream(audio_bytes, AUDEERING_WS, "audeering"),
        _stream(audio_bytes, EMOTION2VEC_WS, "emotion2vec+"),
        _stream_hume(audio_bytes, hume_key) if hume_key else _empty_async(),
    )
    # Original (server-side mapping, server-side label)
    a_lbl, a_int, a_n = _aggregate(aud_resp)
    e_lbl, e_int, e_n = _aggregate(e2v_resp)
    # Re-ranked (client-side recalibration on raw fields)
    a2_lbl, a2_int, _ = _aggregate_audeering_remapped(aud_resp)
    e2_lbl, e2_int, _ = _aggregate_e2v_reranked(e2v_resp)
    # Hume aggregated to Plutchik buckets
    h_lbl, h_int, h_n = _hume_aggregate(hume_resp)

    print(f"  audeering    raw: {a_lbl} ({a_int:.2f}) | recentered: {a2_lbl} ({a2_int:.2f})")
    print(f"  emotion2vec+ raw: {e_lbl} ({e_int:.2f}) | drop-neutral: {e2_lbl} ({e2_int:.2f})")
    print(f"  hume         -> {h_lbl} ({h_int:.2f}, n={h_n})")
    if hume_resp and getattr(_hume_aggregate, "last_log", None):
        for (idx, name, score, bucket) in _hume_aggregate.last_log:
            print(f"               chunk {idx}: top={name} ({score:.2f}) -> {bucket}")
    return (
        path.name, expected,
        a_lbl, a_int, a_n,
        e_lbl, e_int, e_n,
        a2_lbl, a2_int,
        e2_lbl, e2_int,
        h_lbl, h_int, h_n,
    )


async def _empty_async():
    return []


def _print_summary(rows):
    print("\n" + "=" * 132)
    print(f"{'file':<14} {'expected':<10}  {'audeering raw':<16} {'aud recentered':<16}  {'e2v raw':<16} {'e2v drop-neut':<16}  {'hume':<16}")
    print("-" * 132)
    aud_ok = aud_rec_ok = e2v_ok = e2v_drop_ok = hume_ok = 0
    n = len(rows)
    for row in rows:
        (name, exp, a_lbl, a_int, _, e_lbl, e_int, _,
         a2_lbl, a2_int, e2_lbl, e2_int,
         h_lbl, h_int, _h_n) = row
        e_mapped = PLUTCHIK_FROM_E2V.get(e_lbl, e_lbl) if e_lbl else None
        e2_mapped = PLUTCHIK_FROM_E2V.get(e2_lbl, e2_lbl) if e2_lbl else None

        a_match  = a_lbl == exp
        a2_match = a2_lbl == exp
        e_match  = e_mapped == exp
        e2_match = e2_mapped == exp
        h_match  = h_lbl == exp
        if a_match:  aud_ok += 1
        if a2_match: aud_rec_ok += 1
        if e_match:  e2v_ok += 1
        if e2_match: e2v_drop_ok += 1
        if h_match:  hume_ok += 1

        def cell(lbl, ok, intensity):
            mark = "OK" if ok else "  "
            return f"{mark} {(lbl or '-'):<11} {intensity:.2f}"

        print(
            f"{name:<14} {exp:<10}  "
            f"{cell(a_lbl, a_match, a_int):<16} {cell(a2_lbl, a2_match, a2_int):<16}  "
            f"{cell(e_mapped, e_match, e_int):<16} {cell(e2_mapped, e2_match, e2_int):<16}  "
            f"{cell(h_lbl, h_match, h_int):<16}"
        )
    print("=" * 132)
    print(f"\nScore (out of {n}):")
    print(f"  audeering raw          {aud_ok}/{n}")
    print(f"  audeering recentered   {aud_rec_ok}/{n}    (valence center 0.5 -> 0.4)")
    print(f"  emotion2vec+ raw       {e2v_ok}/{n}")
    print(f"  emotion2vec+ drop-neut {e2v_drop_ok}/{n}    (skip neutral, take top non-neutral)")
    print(f"  hume prosody           {hume_ok}/{n}    (48 emotions averaged into Plutchik buckets)")


async def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    test_dir = Path(sys.argv[1])
    if not test_dir.is_dir():
        print(f"Not a directory: {test_dir}")
        sys.exit(1)

    audio_files = sorted([
        f for f in test_dir.iterdir()
        if f.suffix.lower() in {".wav", ".m4a", ".mp3", ".ogg", ".flac"}
    ])
    if not audio_files:
        print(f"No audio files found in {test_dir}")
        sys.exit(1)

    rows = []
    for f in audio_files:
        rows.append(await _test_file(f, f.stem.lower()))
    _print_summary(rows)


if __name__ == "__main__":
    # Windows console default cp1252 chokes on emotion2vec's Chinese
    # label suffixes (which we strip but defensive utf-8 anyway).
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        import websockets  # noqa: F401
        import numpy  # noqa: F401
        import imageio_ffmpeg  # noqa: F401
        from dotenv import load_dotenv
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install with:  pip install websockets numpy imageio-ffmpeg python-dotenv")
        sys.exit(1)
    # Load HUME_API_KEY (and any other env) from ojaq-proxy/.env
    from pathlib import Path as _Path
    load_dotenv(_Path(__file__).parent.parent / ".env")
    asyncio.run(main())

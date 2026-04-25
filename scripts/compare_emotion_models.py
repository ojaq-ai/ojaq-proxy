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

# Map emotion2vec+'s 9-class output → Plutchik 8 (+ neutral) so the
# comparison reads side by side. "other" / "unknown" collapse to neutral.
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
}


def _load_audio_int16(path: Path):
    """Load any audio file → 16kHz mono int16 PCM bytes."""
    import librosa
    import numpy as np
    audio, _sr = librosa.load(str(path), sr=16000, mono=True)
    int16 = (audio * 32767.0).clip(-32768, 32767).astype(np.int16)
    return int16.tobytes(), len(audio) / 16000.0


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


async def _test_file(path: Path, expected: str):
    print(f"\n--- {path.name} (expected: {expected}) ---")
    try:
        audio_bytes, duration = _load_audio_int16(path)
    except Exception as e:
        print(f"  load failed: {type(e).__name__}: {e}")
        return (path.name, expected, None, 0.0, 0, None, 0.0, 0)
    print(f"  duration: {duration:.1f}s")

    # Run the two endpoints concurrently to halve wall-clock time
    aud_resp, e2v_resp = await asyncio.gather(
        _stream(audio_bytes, AUDEERING_WS, "audeering"),
        _stream(audio_bytes, EMOTION2VEC_WS, "emotion2vec+"),
    )
    a_lbl, a_int, a_n = _aggregate(aud_resp)
    e_lbl, e_int, e_n = _aggregate(e2v_resp)
    print(f"  audeering    → {a_lbl} ({a_int:.2f}, n={a_n})")
    print(f"  emotion2vec+ → {e_lbl} ({e_int:.2f}, n={e_n})")
    return (path.name, expected, a_lbl, a_int, a_n, e_lbl, e_int, e_n)


def _print_summary(rows):
    print("\n" + "=" * 92)
    print(f"{'file':<16} {'expected':<10}  {'audeering':<26}  {'emotion2vec+ → plutchik':<32}")
    print("-" * 92)
    aud_ok = e2v_ok = 0
    for (name, exp, a_lbl, a_int, a_n, e_lbl, e_int, e_n) in rows:
        e_mapped = PLUTCHIK_FROM_E2V.get(e_lbl, e_lbl) if e_lbl else None
        a_mark = "✓" if a_lbl == exp else "·"
        e_mark = "✓" if e_mapped == exp else "·"
        if a_lbl == exp: aud_ok += 1
        if e_mapped == exp: e2v_ok += 1
        a_str = f"{a_lbl or '—':<10} ({a_int:.2f}, n={a_n:>2})"
        e_str = f"{(e_lbl or '—') + ' → ' + (e_mapped or '—'):<22} ({e_int:.2f})"
        print(f"{name:<16} {exp:<10}  {a_mark} {a_str:<24}  {e_mark} {e_str}")
    print("=" * 92)
    n = len(rows)
    print(f"\nScore: audeering {aud_ok}/{n}  |  emotion2vec+ {e2v_ok}/{n}")


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
    try:
        import librosa  # noqa: F401
        import websockets  # noqa: F401
        import numpy  # noqa: F401
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install with:  pip install librosa websockets numpy")
        sys.exit(1)
    asyncio.run(main())

import asyncio
import json
import logging
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

from gemini_live import GeminiLiveSession

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ojaq-proxy")

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

_ROOT = Path(__file__).resolve().parent.parent
TEST_HTML = _ROOT / "test_browser" / "index.html"
LANDING_HTML = _ROOT / "landing" / "index.html"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

app = FastAPI(title="ojaq-proxy")


@app.get("/")
async def landing_page():
    return FileResponse(LANDING_HTML, media_type="text/html")


@app.get("/test")
async def test_page():
    return FileResponse(TEST_HTML, media_type="text/html")


@app.get("/token")
async def get_token():
    """Hand the API key to the browser so it never appears in client source."""
    if not GEMINI_API_KEY:
        return {"error": "GEMINI_API_KEY not set"}, 500
    return {"token": GEMINI_API_KEY}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("RN client connected")

    gemini = GeminiLiveSession()

    try:
        await gemini.connect()

        async def gemini_to_rn():
            """Forward Gemini outputs to React Native client."""
            async for msg in gemini.receive():
                t = msg["type"]
                if t == "audio":
                    await ws.send_bytes(msg["data"])
                elif t == "presence":
                    await ws.send_text(msg["data"])
                elif t == "interrupted":
                    await ws.send_text('{"interrupted":true}')
                elif t in ("transcript_in", "transcript_out"):
                    await ws.send_text(json.dumps(
                        {t: msg["data"]}
                    ))

        async def rn_to_gemini():
            """Forward RN input to Gemini."""
            while True:
                frame = await ws.receive()
                if "bytes" in frame and frame["bytes"]:
                    await gemini.send_audio(frame["bytes"])
                elif "text" in frame and frame["text"]:
                    await gemini.send_text(frame["text"])
                elif frame.get("type") == "websocket.disconnect":
                    break

        tasks = [
            asyncio.create_task(gemini_to_rn()),
            asyncio.create_task(rn_to_gemini()),
        ]

        done, pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()
        for t in done:
            if t.exception():
                logger.error(f"Task error: {t.exception()}")

    except WebSocketDisconnect:
        logger.info("RN client disconnected")
    except Exception as e:
        logger.error(f"Session error: {e}")
    finally:
        await gemini.close()
        try:
            await ws.close()
        except Exception:
            pass
        logger.info("Session ended")


# Static mount for playground (must come after all route definitions)
PLAYGROUND = _ROOT / "playground"
app.mount("/playground", StaticFiles(directory=PLAYGROUND, html=True), name="playground")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host=HOST, port=PORT, reload=True)

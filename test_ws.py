import asyncio
import websockets


async def main():
    uri = "ws://localhost:8000/ws"
    print(f"Connecting to {uri} ...")
    async with websockets.connect(uri) as ws:
        # Send 3200 bytes of silence (16-bit PCM zeros = 100 ms at 16 kHz)
        silence = b"\x00" * 3200
        await ws.send(silence)
        print(f"Sent {len(silence)} bytes of silence")

        # Listen for responses (timeout after 10s of no data)
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=10.0)
                if isinstance(msg, bytes):
                    print(f"[binary] {len(msg)} bytes")
                else:
                    print(f"[text]   {msg}")
        except asyncio.TimeoutError:
            print("No more data (10s timeout). Done.")


if __name__ == "__main__":
    asyncio.run(main())

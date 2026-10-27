# Wave2Bit

Wave2Bit is a simple educational demonstration of Pulse Code Modulation (PCM).

It shows:

Voice
→ Analog Signal
→ Sampling
→ Quantization
→ Binary Encoding
→ Noise
→ Received Binary

## Run Locally

Start a local server:

python -m http.server 5500

Open:

http://localhost:5500

The **Use Demo Voice** button plays `demo.wav`, a synthesized voice saying
"one, two". It is loaded over HTTP, so open the page through the local server
(or Vercel) rather than double-clicking `index.html`.

## Deploy to Vercel

Push the project to GitHub.

Import the repository into Vercel.

No backend or environment variables are required.

import { NextResponse } from "next/server";

/**
 * 语音会话 —— 文本转语音（edge-tts），返回 audio/mpeg。
 * 调用方 POST { text, voice? }，得到 mp3 字节流供网页播放。
 */
const VOICE_SERVICE = process.env.PI_VOICE_SERVICE_URL ?? "http://127.0.0.1:8765";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let req: { text?: string; voice?: string };
  try {
    req = (await request.json()) as { text?: string; voice?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const text = String(req.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ ok: false, error: "empty text" }, { status: 400 });
  }
  try {
    const res = await fetch(`${VOICE_SERVICE}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: req.voice }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `tts ${res.status}` }, { status: 502 });
    }
    const audio = await res.arrayBuffer();
    return new Response(audio, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "voice service unavailable" }, { status: 502 });
  }
}

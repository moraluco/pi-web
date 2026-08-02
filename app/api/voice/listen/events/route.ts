/**
 * 语音会话 —— SSE 事件流代理（utterance / speech_start / speech_end / error）。
 * 浏览器 EventSource 直连本地 pi-voice 服务的事件流。
 */
const VOICE_SERVICE = process.env.PI_VOICE_SERVICE_URL ?? "http://127.0.0.1:8765";

export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function GET() {
  let upstream: Response;
  try {
    upstream = await fetch(`${VOICE_SERVICE}/api/listen/events`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return new Response(`data: ${JSON.stringify({ event: "error", message: "voice service unavailable" })}\n\n`, {
      headers: SSE_HEADERS,
    });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(
      `data: ${JSON.stringify({ event: "error", message: `upstream ${upstream.status}` })}\n\n`,
      { headers: SSE_HEADERS },
    );
  }
  // 直接透传上游 SSE 字节流
  return new Response(upstream.body, { headers: SSE_HEADERS });
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 语音会话（F3）—— 全双工对话模式。
 *
 * 链路：服务端麦克风 VAD 常开（/api/voice/listen/start + SSE events）
 *  → 逐句 utterance → 发送队列（agent 忙时排队，空闲逐条 onSend）
 *  → 回复增量文本 → 按句 TTS（/api/voice/tts）队列朗读
 *  → 用户开口（speech_start）→ 立即打断朗读。
 *
 * 设计原则：可选项。语音服务不可用则 available=false，界面隐藏会话按钮。
 */
export interface VoiceChatApi {
  available: boolean; // 语音服务可用（探测）
  active: boolean; // 会话进行中
  busy: boolean; // 有句子在发送/排队中
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** 朗读增量文本（回复流驱动）；内部按句切分排队 */
  speak: (delta: string) => void;
  /** 立即停止朗读并清空队列 */
  stopSpeak: () => void;
}

interface Options {
  /** 把转写文本发送给 pi（agent 空闲时） */
  onSend: (text: string) => void;
  /** agent 是否正在处理（忙时语音句子进队列） */
  isAgentBusy: () => boolean;
}

/** 切句：仅完整句尾（。！？…；换行）或累计达到阈值 */
function splitSentences(buf: string): { ready: string[]; rest: string } {
  const parts = buf.split(/(?<=[。！？…；\n])/);
  const ready: string[] = [];
  let rest = "";
  if (parts.length > 1) {
    ready.push(...parts.slice(0, -1).map((s) => s.trim()).filter(Boolean));
    rest = parts[parts.length - 1];
  } else {
    rest = buf;
  }
  return { ready, rest };
}

export function useVoiceChat({ onSend, isAgentBusy }: Options): VoiceChatApi {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const sendQueueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);

  // TTS 朗读队列
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ttsSentenceRef = useRef(""); // 未成句缓冲
  const ttsStoppedRef = useRef(false);

  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const isAgentBusyRef = useRef(isAgentBusy);
  isAgentBusyRef.current = isAgentBusy;

  // ---- 发送队列：agent 忙时排队，空闲逐条发送 ----
  const drainQueue = useCallback(() => {
    if (drainingRef.current) return;
    if (sendQueueRef.current.length === 0) {
      setBusy(false);
      return;
    }
    if (isAgentBusyRef.current()) return; // 等待空闲，下次 tick 再来
    drainingRef.current = true;
    setBusy(true);
    const next = sendQueueRef.current.shift()!;
    try {
      onSendRef.current(next);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      drainingRef.current = false;
      drainQueue();
    }, 400); // 给 agent 启动留一点间隔
  }, []);

  const enqueueSend = useCallback(
    (text: string) => {
      sendQueueRef.current.push(text);
      setBusy(true);
      drainQueue();
    },
    [drainQueue],
  );

  // ---- TTS 播放 ----
  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.onended = () => {
        ttsPlayingRef.current = false;
        void playNextTts();
      };
      audioRef.current.onerror = () => {
        ttsPlayingRef.current = false;
        void playNextTts();
      };
    }
    return audioRef.current;
  }, []);

  const playNextTts = useCallback(async () => {
    if (ttsStoppedRef.current || ttsPlayingRef.current) return;
    const sentence = ttsQueueRef.current.shift();
    if (!sentence) return;
    ttsPlayingRef.current = true;
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sentence }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      if (ttsStoppedRef.current) {
        ttsPlayingRef.current = false;
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = ensureAudio();
      audio.src = url;
      await audio.play();
      audio.onended = () => {
        URL.revokeObjectURL(url);
        ttsPlayingRef.current = false;
        void playNextTts();
      };
    } catch {
      ttsPlayingRef.current = false;
      void playNextTts();
    }
  }, [ensureAudio]);

  const speak = useCallback(
    (delta: string) => {
      if (ttsStoppedRef.current) return;
      ttsSentenceRef.current += delta;
      const { ready, rest } = splitSentences(ttsSentenceRef.current);
      if (ready.length) {
        ttsQueueRef.current.push(...ready);
        ttsSentenceRef.current = rest;
        void playNextTts();
      }
    },
    [playNextTts],
  );

  const stopSpeak = useCallback(() => {
    ttsStoppedRef.current = true;
    ttsQueueRef.current = [];
    ttsSentenceRef.current = "";
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      try {
        audioRef.current.load();
      } catch {
        /* ignore */
      }
    }
    ttsPlayingRef.current = false;
    void fetch("/api/voice/tts/stop", { method: "POST" }).catch(() => {});
  }, []);

  // ---- 会话生命周期 ----
  const start = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/voice/listen/start", { method: "POST", signal: AbortSignal.timeout(5000) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "listen start failed");

      ttsStoppedRef.current = false;
      ttsQueueRef.current = [];
      ttsSentenceRef.current = "";
      sendQueueRef.current = [];
      setActive(true);

      const es = new EventSource("/api/voice/listen/events");
      esRef.current = es;
      const onUtterance = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { text?: string };
          if (msg.text) enqueueSend(msg.text);
        } catch {
          /* 忽略无法解析的事件 */
        }
      };
      const onSpeechStart = () => {
        // 用户开口 → 打断朗读
        stopSpeak();
      };
      const onError = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { message?: string };
          setError(msg.message ?? "语音服务错误");
        } catch {
          setError("语音服务错误");
        }
      };
      es.addEventListener("utterance", onUtterance);
      es.addEventListener("speech_start", onSpeechStart);
      es.addEventListener("error", onError);
      es.onerror = () => {
        // EventSource 会自动重连；网络层错误无需打扰用户
      };
    } catch (e) {
      setError((e as Error).message);
    }
  }, [enqueueSend, stopSpeak]);

  const stop = useCallback(async () => {
    setActive(false);
    esRef.current?.close();
    esRef.current = null;
    sendQueueRef.current = [];
    setBusy(false);
    stopSpeak();
    try {
      await fetch("/api/voice/listen/stop", { method: "POST", signal: AbortSignal.timeout(5000) });
    } catch {
      /* ignore */
    }
  }, [stopSpeak]);

  // 卸载清理
  useEffect(() => {
    return () => {
      esRef.current?.close();
      stopSpeak();
    };
  }, [stopSpeak]);

  // 服务探测（复用麦克风按钮的探测逻辑）
  useEffect(() => {
    let cancelled = false;
    fetch("/api/voice/status", { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { ok?: boolean }) => {
        if (!cancelled) setAvailable(Boolean(d?.ok));
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 空闲轮询：agent 完成后清发送队列
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (sendQueueRef.current.length > 0 && !isAgentBusyRef.current()) {
        drainQueue();
      }
    }, 600);
    return () => clearInterval(id);
  }, [active, drainQueue]);

  return { available, active, busy, error, start, stop, speak, stopSpeak };
}

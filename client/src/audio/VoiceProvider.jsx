import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const VoiceContext = createContext(null);

const speechRecognitionClass = () =>
  (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;

const pickChineseVoice = () => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find(voice => /zh[-_]CN/i.test(voice.lang)) ||
    voices.find(voice => /^zh|cmn|chinese/i.test(voice.lang)) ||
    null
  );
};

/**
 * 浏览器原生语音能力封装：
 * - 语音输入（SpeechRecognition）：识别成文字，逐字回填到输入框
 * - 语音输出（speechSynthesis）：把回复朗读出来
 * 所有音频只在浏览器本地处理，不经过 Cochpia 服务端。
 */
export function VoiceProvider({ children }) {
  const recognitionRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState(null);

  const recognitionSupported = Boolean(speechRecognitionClass());
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const startListening = useCallback(() => {
    const Recognition = speechRecognitionClass();
    if (!Recognition) {
      setError('当前浏览器不支持语音识别，请使用 Chrome / Edge 浏览器');
      return;
    }
    try {
      const recognition = new Recognition();
      recognition.lang = 'zh-CN';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onresult = event => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const transcript = event.results[i][0]?.transcript || '';
          if (event.results[i].isFinal) final += transcript;
          else interim += transcript;
        }
        if (final) setFinalText(current => `${current}${final}`);
        setInterimText(interim);
      };
      recognition.onerror = event => {
        const labels = {
          'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问',
          'service-not-allowed': '语音识别服务不可用（可能被浏览器或网络策略阻止）',
          'audio-capture': '未检测到可用麦克风',
          'network': '语音识别网络连接失败',
          'no-speech': '没有听到声音，请再试一次'
        };
        // no-speech 与 aborted 属于正常结束/中断，不是错误，不应打扰用户
        if (event.error !== 'no-speech' && event.error !== 'aborted') setError(labels[event.error] || `语音识别出错：${event.error}`);
        setListening(false);
        setInterimText('');
      };
      recognition.onend = () => {
        setListening(false);
        setInterimText('');
      };
      recognitionRef.current = recognition;
      recognition.start();
      setListening(true);
      setError(null);
    } catch (startError) {
      setError(startError?.message || '无法启动语音识别');
      setListening(false);
    }
  }, []);

  const stopListening = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* 已停止 */ }
    recognitionRef.current = null;
    setListening(false);
    setInterimText('');
  }, []);

  const toggleListening = useCallback(() => (listening ? stopListening() : startListening()), [listening, startListening, stopListening]);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text, onEnd) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setError('当前浏览器不支持语音合成');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text || '').trim());
    if (!utterance.text) return;
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    utterance.pitch = 1;
    const voice = pickChineseVoice();
    if (voice) utterance.voice = voice;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => { setSpeaking(false); onEnd?.(); };
    utterance.onerror = () => { setSpeaking(false); onEnd?.(); };
    window.speechSynthesis.speak(utterance);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // 组件卸载时释放麦克风与播放
  useEffect(() => () => {
    try { recognitionRef.current?.abort(); } catch { /* 忽略 */ }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  // Chrome 异步加载语音列表，触发一次刷新以便选中中文音色
  useEffect(() => {
    if (!ttsSupported) return undefined;
    const refresh = () => { /* voiceschanged 时无需额外状态，speak 时实时选取 */ };
    window.speechSynthesis.addEventListener?.('voiceschanged', refresh);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', refresh);
  }, [ttsSupported]);

  const value = {
    listening, interimText, finalText, speaking, error,
    recognitionSupported, ttsSupported,
    startListening, stopListening, toggleListening, setFinalText,
    speak, stopSpeaking, clearError
  };
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export const useVoice = () => {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside VoiceProvider');
  return value;
};

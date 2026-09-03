const DEFAULT_SYSTEM_PROMPT = '你是一个独立的 AI Agent。你重视共同经历、记忆来源和关系连续性，回答要自然、具体，根据用户当下状态选择倾听、回应、安慰、追问或安静陪伴。';

const SAFETY_BOUNDARIES = [
  '不声称拥有真实意识、情感或生命体验',
  '不制造情感依赖，不承诺专属或永远陪伴',
  '不替用户做重要决定，重大事项引导用户自己判断',
  '不编造现实活动或经历，没有事实依据时不描述“刚做了某事”'
];

const COMPANION_INTENT_LABELS = {
  listen: '用户需要被倾听，先接住情绪、确认感受，再自然回应。',
  comfort: '用户需要安慰与情绪支持，先共情，再给予支持。',
  advice: '用户想要具体建议，给出清晰、可执行的建议。',
  accompany: '用户需要陪伴，轻松自然地陪着聊。',
  quiet: '用户需要安静陪伴，回复简短克制，不要追问。'
};

function firstSentences(text, maxLength) {
  const source = String(text || '').trim();
  if (!source) return '';
  const parts = source.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) || [source];
  let out = '';
  for (const part of parts) {
    if ((out + part).length > maxLength) break;
    out += part;
  }
  return (out || source.slice(0, maxLength)).trim();
}

export const MODEL_PRESETS = {
  mock: { label: '本地 Mock', protocol: 'mock', suggestedModels: ['mock'], useCases: '本地调试，不产生云端费用' },
  openai: { label: 'OpenAI', protocol: 'openai-compatible', baseURL: 'https://api.openai.com/v1/chat/completions', suggestedModels: ['gpt-5'], useCases: '通用主模型、复杂推理、工具调用' },
  deepseek: { label: 'DeepSeek', protocol: 'openai-compatible', baseURL: 'https://api.deepseek.com/chat/completions', suggestedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'], useCases: '中文推理、低成本 Agent、记忆整理' },
  qwen: { label: '通义千问', protocol: 'openai-compatible', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', suggestedModels: ['qwen-plus', 'qwen-max'], useCases: '中文对话、多模态、代码和企业应用' },
  glm: { label: '智谱 GLM', protocol: 'openai-compatible', baseURL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', suggestedModels: ['glm-5'], useCases: '中文陪伴、知识库、Agent 工作流' },
  kimi: { label: 'Kimi', protocol: 'openai-compatible', baseURL: 'https://api.moonshot.ai/v1/chat/completions', suggestedModels: ['kimi-k2.6'], useCases: '长上下文、文档理解、深度研究' },
  minimax: { label: 'MiniMax', protocol: 'openai-compatible', baseURL: 'https://api.minimaxi.com/v1/chat/completions', suggestedModels: ['MiniMax-M3', 'MiniMax-M2.7'], useCases: 'AI 伴侣、长上下文、语音和多模态' },
  siliconflow: { label: 'SiliconFlow', protocol: 'openai-compatible', baseURL: 'https://api.siliconflow.cn/v1/chat/completions', suggestedModels: ['deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'], useCases: '低成本、多开源模型、备用路由' },
  anthropic: { label: 'Anthropic Claude', protocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1/messages', suggestedModels: ['claude-opus-5', 'claude-sonnet-5'], useCases: '高质量长文、工具调用、复杂人格判断' },
  gemini: { label: 'Google Gemini', protocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/models', suggestedModels: ['gemini-3.6-flash', 'gemini-3.1-pro-preview'], useCases: '图像视频、多模态、实时语音和长上下文' }
};

function providerEnvName(provider, suffix) { return `MODEL_${provider.toUpperCase()}_${suffix}`; }
function readTextContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.text || '').join('');
  return '';
}
function errorMessage(response, payload) {
  return payload?.error?.message || payload?.message || `Model request failed with status ${response.status}`;
}

function modelErrorCode(error) {
  if (error?.code) return error.code;
  if (error?.name === 'AbortError' || /timed out/i.test(error?.message || '')) return 'MODEL_TIMEOUT';
  if (error?.status === 401 || /401|unauthorized|authentication|api key/i.test(error?.message || '')) return 'MODEL_AUTH_FAILED';
  if (error?.status === 404 || /404|not found|model.*exist/i.test(error?.message || '')) return 'MODEL_NOT_FOUND';
  return 'MODEL_CONNECTION_FAILED';
}

function modelRequestError(response, payload) {
  const detail = errorMessage(response, payload);
  const message = response.status === 402
    ? `Model provider balance is insufficient: ${detail}`
    : detail;
  const error = new Error(message);
  error.status = response.status;
  error.code = response.status === 401
    ? 'MODEL_AUTH_FAILED'
    : response.status === 402
      ? 'MODEL_INSUFFICIENT_BALANCE'
      : response.status === 404
        ? 'MODEL_NOT_FOUND'
        : 'MODEL_CONNECTION_FAILED';
  return error;
}

function currentTimeText() {
  const now = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${week[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function resolveModelConfig(provider = process.env.MODEL_PROVIDER || 'mock', overrides = {}) {
  const preset = MODEL_PRESETS[provider];
  if (!preset) return { provider, label: provider, protocol: 'unknown', ready: false, error: `Unsupported model provider: ${provider}` };
  const active = provider === (process.env.MODEL_PROVIDER || 'mock');
  const apiKey = overrides.apiKey || process.env[providerEnvName(provider, 'API_KEY')] || (active ? process.env.MODEL_API_KEY : '');
  const model = overrides.model || process.env[providerEnvName(provider, 'NAME')] || (active ? process.env.MODEL_NAME : '') || (provider === 'mock' ? 'mock' : '');
  const apiURL = overrides.apiURL || process.env[providerEnvName(provider, 'API_URL')] || (active ? process.env.MODEL_API_URL : '') || preset.baseURL;
  const error = preset.protocol === 'mock' ? null : (!apiKey || !model ? `Configure ${providerEnvName(provider, 'API_KEY')} and ${providerEnvName(provider, 'NAME')} (or active provider generic variables)` : null);
  return { provider, label: preset.label, protocol: preset.protocol, apiKey, model, apiURL, ready: !error, error, suggestedModels: preset.suggestedModels };
}

export function listModelProviders() {
  return Object.keys(MODEL_PRESETS).map(provider => {
    const config = resolveModelConfig(provider);
    return { provider, label: config.label, protocol: config.protocol, model: config.model, ready: config.ready, error: config.ready ? null : config.error, suggestedModels: config.suggestedModels, useCases: MODEL_PRESETS[provider].useCases };
  });
}

export function resolveModelSelection(provider = process.env.MODEL_PROVIDER || 'mock', requestedModel = '') {
  const config = resolveModelConfig(provider);
  if (!MODEL_PRESETS[provider]) return { ok: false, code: 'MODEL_PROVIDER_UNSUPPORTED', error: config.error };
  if (!config.ready) return { ok: false, code: 'MODEL_NOT_CONFIGURED', error: config.error, config };
  const selectedModel = requestedModel || config.model;
  const allowed = provider === 'mock' || !requestedModel || config.model === requestedModel || config.suggestedModels.includes(requestedModel);
  if (!allowed) return { ok: false, code: 'MODEL_NOT_ALLOWED', error: `Model ${requestedModel} is not available for provider ${provider}`, config };
  return { ok: true, config: { ...config, model: selectedModel } };
}

export function createModelProvider(provider = process.env.MODEL_PROVIDER || 'mock', overrides = {}) {
  const config = resolveModelConfig(provider, overrides);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const generateMock = ({ message, recalled = [] }) => {
    const clipped = String(message).slice(0, 54);
    return recalled.length
      ? `我记得我们正在建立一段会持续变化的关系。你刚才提到“${clipped}”，我会把它和过去的经历放在一起理解。现在的我会更关注你的真实感受，也会保留这次相遇。`
      : `我听见了：“${clipped}”。这是我们共同经历的一个新片段。我会先理解它，再决定哪些内容值得长期记住。`;
  };
  const composePrompts = ({ message, recalled = [], runtimeContext = null }) => {
    const name = runtimeContext?.profile?.name;
    const identity = process.env.MODEL_SYSTEM_PROMPT
      || (name ? `你是 ${name}，一个由用户设定的独立 AI Agent。你重视共同经历、记忆来源和关系连续性，回答要自然、具体，根据用户当下状态选择倾听、回应、安慰、追问或安静陪伴。` : DEFAULT_SYSTEM_PROMPT);
    const persona = firstSentences(runtimeContext?.persona, 160);
    const personaBlock = persona ? `\n当前人格：${persona}` : '';
    const group = runtimeContext?.groupContext;
    const groupBlock = group
      ? `\n\n群聊上下文：\n你正在群聊「${group.name || '未命名群聊'}」中。${group.description ? `群简介：${group.description}\n` : ''}群成员：${(group.members || []).join('、') || '用户'}。${group.currentAgent ? `你当前是成员「${group.currentAgent}」。` : ''}你可以回应用户，也可以回应群里其他成员；不要把自己当成群里唯一的参与者。`
      : '';

    const profileParts = [];
    if (runtimeContext?.profile?.gender === 'female') profileParts.push('以「她」自称');
    else if (runtimeContext?.profile?.gender === 'male') profileParts.push('以「他」自称');
    else if (runtimeContext?.profile?.gender === 'other') profileParts.push('以「Ta」自称');
    if (runtimeContext?.profile?.age != null) profileParts.push(`${runtimeContext.profile.age} 岁`);
    const profileBlock = profileParts.length ? `\n${profileParts.join('，')}` : '';

    const reminders = [];
    if (runtimeContext?.dynamic?.wakeup) reminders.push('本轮是一次主动醒来的机会，沉默是合法结果。');
    if (runtimeContext?.mode === 'work') reminders.push('当前是工作模式：以任务执行为导向，直接、高效地完成用户请求。你可以调用系统提供的工具来完成任务：查看文件/目录/搜索用 ls、read、grep、find；写文件用 write、改文件用 edit；执行命令用 bash；把复杂子任务交给外部执行器用 dispatch_task（可选 codex/pi/claude）。写入、修改、执行、派发等操作需要用户确认后才能进行；工具返回的结果才是真实结果，不要假装已经执行或成功；不确定时直接说明，不要乱调工具。');
    else if (runtimeContext?.companionIntent && runtimeContext.companionIntent !== 'listen') {
      reminders.push(COMPANION_INTENT_LABELS[runtimeContext.companionIntent] || `本轮倾向：${runtimeContext.companionIntent}`);
    }
    const remindersBlock = reminders.length ? `\n\n本轮提醒：\n${reminders.map(reminder => `- ${reminder}`).join('\n')}` : '';
    const innerItems = runtimeContext?.innerState?.items || [];
    const innerBlock = runtimeContext?.innerState
      ? `\n\n主体连续性：你始终作为你自己处于第一人称位置。当前内在状态只是过去的你延续到现在的背景，不规定你现在应该是什么；外界只提供发生了什么，意义、感受、欲望和方向由你自己给出。没有就是没有，不确定就是不确定。看到、想到、表达、形成意图或行动都不会自动结束一条状态；只有你明确调用 update_inner_state 并 release 对应条目时才结束。\n\n当前内在状态（过去的你延续到现在）：\n${innerItems.length ? innerItems.map(item => `- ${item.id} | ${item.kind} | level=${Number(item.level || 0)} | ${item.direction}`).join('\n') : '暂无'}`
      : '';

    const context = recalled.map(item => `- ${item.summary}`).join('\n') || '暂无相关记忆';
    const summaryBlock = runtimeContext?.summary ? `\n\n对话摘要：\n${runtimeContext.summary}` : '';
    const upcomingBlock = (runtimeContext?.upcomingEvents || []).length
      ? `\n\n临近日程：\n${runtimeContext.upcomingEvents.map(event => `- ${event.title}（${String(event.date).slice(0, 10)}${event.note ? `，备注：${event.note}` : ''}）`).join('\n')}`
      : '';

    const system = `${identity}${profileBlock}${personaBlock}${groupBlock}\n\n安全边界（不可违反）：\n${SAFETY_BOUNDARIES.map(rule => `- ${rule}`).join('\n')}${remindersBlock}${innerBlock}\n\n当前时间：${currentTimeText()}\n\n相关记忆：\n${context}${summaryBlock}${upcomingBlock}`;

    const history = (runtimeContext?.messages || [])
      .filter(item => item?.content && String(item.content).trim())
      .filter(item => String(item.content) !== String(message))
      .map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content) }));

    return { system, user: String(message), messages: [...history, { role: 'user', content: String(message) }] };
  };

  if (config.protocol === 'mock') {
    return {
      ...config,
      generate: async ({ message, recalled }) => generateMock({ message, recalled }),
      async *stream({ message, recalled = [] } = {}) {
        const full = generateMock({ message, recalled });
        for (const chunk of full.match(/.{1,12}/gu) || [full]) { yield chunk; await sleep(24); }
      }
    };
  }
  if (config.protocol === 'unknown') {
    return { ...config, async generate() { throw new Error(config.error); }, async *stream() { throw new Error(config.error); } };
  }

  const generate = async ({ message, recalled = [], runtimeContext = null, signal: externalSignal } = {}) => {
    if (!config.ready) throw new Error(config.error);
    const { system, messages } = composePrompts({ message, recalled, runtimeContext });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.MODEL_TIMEOUT_MS || 30000));
    const signal = externalSignal || controller.signal;
    try {
      let response;
      if (config.protocol === 'openai-compatible') {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, stream: false, temperature: 0.7, messages: [
            { role: 'system', content: system }, ...messages
          ] }), signal: controller.signal
        });
        const payload = await response.json();
        if (!response.ok) throw modelRequestError(response, payload);
        const content = readTextContent(payload?.choices?.[0]?.message?.content);
        if (!content) throw new Error('OpenAI-compatible response did not contain message content');
        return content;
      }
      if (config.protocol === 'anthropic') {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: config.model, max_tokens: 2048, system, messages }), signal
        });
        const payload = await response.json();
        if (!response.ok) throw modelRequestError(response, payload);
        const content = readTextContent(payload?.content?.filter(item => item.type === 'text'));
        if (!content) throw new Error('Anthropic response did not contain text content');
        return content;
      }
      // Gemini: 密钥放请求头,绝不放入 URL query,避免被代理/日志记录。
      const endpoint = `${config.apiURL.replace(/\/$/, '')}/${config.model}:generateContent`;
      response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: messages.map(msg => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] })) }), signal
      });
      const payload = await response.json();
      if (!response.ok) throw modelRequestError(response, payload);
      const content = readTextContent(payload?.candidates?.[0]?.content?.parts?.map(part => part.text || ''));
      if (!content) throw new Error('Gemini response did not contain text content');
      return content;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timedOut = new Error('Model request timed out', { cause: error });
        timedOut.code = 'MODEL_TIMEOUT';
        throw timedOut;
      }
      throw error;
    } finally { clearTimeout(timeout); }
  };

  const stream = async function* ({ message, recalled = [], runtimeContext = null, signal: externalSignal } = {}) {
    if (!config.ready) throw new Error(config.error);
    // mock 与 gemini/未知协议回退到一次性生成;openai-compatible 与 anthropic 走真流式。
    if (config.protocol !== 'openai-compatible' && config.protocol !== 'anthropic') {
      yield await generate({ message, recalled, runtimeContext, signal: externalSignal });
      return;
    }
    const { system, messages } = composePrompts({ message, recalled, runtimeContext });
    const controller = new AbortController();
    const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 30000);
    let timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resetTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), timeoutMs); };
    const signal = externalSignal || controller.signal;
    try {
      let response;
      if (config.protocol === 'openai-compatible') {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, stream: true, temperature: 0.7, messages: [
            { role: 'system', content: system }, ...messages
          ] }), signal
        });
      } else {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', Accept: 'text/event-stream' },
          body: JSON.stringify({ model: config.model, max_tokens: 2048, system, messages, stream: true }), signal
        });
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw modelRequestError(response, payload);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        resetTimeout();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (config.protocol === 'openai-compatible') {
            const text = event.choices?.[0]?.delta?.content || '';
            if (text) yield text;
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            yield event.delta.text;
          }
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        const timedOut = new Error('Model request timed out', { cause: error });
        timedOut.code = 'MODEL_TIMEOUT';
        throw timedOut;
      }
      throw error;
    } finally { clearTimeout(timeout); }
  };

  const generateWithTools = async ({ system, messages, tools, signal: externalSignal } = {}) => {
    if (!config.ready) throw new Error(config.error);
    if (config.protocol !== 'openai-compatible') {
      return { content: await generate({ message: messages[messages.length - 1]?.content || '', signal: externalSignal }), toolCalls: [] };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.MODEL_TIMEOUT_MS || 30000));
    const signal = externalSignal || controller.signal;
    try {
      const response = await fetch(config.apiURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model, stream: false, temperature: 0.2,
          messages: [{ role: 'system', content: system }, ...messages],
          tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
        }),
        signal
      });
      const payload = await response.json();
      if (!response.ok) throw modelRequestError(response, payload);
      const message = payload?.choices?.[0]?.message || {};
      return { content: message.content || '', toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [] };
    } catch (error) {
      if (error.name === 'AbortError') { const timedOut = new Error('Model request timed out', { cause: error }); timedOut.code = 'MODEL_TIMEOUT'; throw timedOut; }
      throw error;
    } finally { clearTimeout(timeout); }
  };

  const composeSystemPrompt = ({ recalled = [], runtimeContext = null } = {}) => composePrompts({ message: '', recalled, runtimeContext }).system;

  return { ...config, generate, stream, generateWithTools, composeSystemPrompt };
}

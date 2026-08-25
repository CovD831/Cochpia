import React, { useEffect, useMemo, useState } from 'react';

const desktop = typeof window !== 'undefined' ? window.desktop : null;
const defaultApiUrls = {
  openai: 'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  kimi: 'https://api.moonshot.ai/v1/chat/completions',
  minimax: 'https://api.minimaxi.com/v1/chat/completions',
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models'
};

function createDrafts(models, config) {
  return Object.fromEntries((models.providers || []).map(provider => {
    const saved = config?.providers?.[provider.provider] || {};
    return [provider.provider, {
      apiKey: '',
      model: saved.model || provider.model || provider.suggestedModels?.[0] || '',
      apiURL: saved.apiURL || defaultApiUrls[provider.provider] || ''
    }];
  }));
}

export function DesktopModelConfig({ models, onConfigured }) {
  const [config, setConfig] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [activeProvider, setActiveProvider] = useState('mock');
  const [busyProvider, setBusyProvider] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    desktop.getModelConfig().then(next => {
      if (!active) return;
      setConfig(next);
      setActiveProvider(next.activeProvider || 'mock');
      setDrafts(createDrafts(models, next));
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [models]);

  const providers = useMemo(() => models.providers || [], [models.providers]);
  if (!desktop) return null;

  const updateDraft = (provider, field, value) => setDrafts(current => ({ ...current, [provider]: { ...current[provider], [field]: value } }));
  const save = async provider => {
    const draft = drafts[provider] || {};
    setBusyProvider(provider);
    setNotice('');
    setError('');
    try {
      const next = await desktop.saveModelConfig({ provider, ...draft, activate: activeProvider === provider });
      setConfig(next);
      setNotice('已保存。桌面服务正在重启，完成后会自动刷新页面。');
      window.setTimeout(() => onConfigured?.(), 800);
    } catch (err) {
      setError(err.message || '保存失败');
    } finally {
      setBusyProvider('');
    }
  };
  const clearKey = async provider => {
    setBusyProvider(provider);
    setError('');
    try {
      const draft = drafts[provider] || {};
      const next = await desktop.saveModelConfig({ provider, ...draft, apiKey: '', clearKey: true, activate: activeProvider === provider });
      setConfig(next);
      setNotice('已清除该供应商的本地密钥。');
    } catch (err) {
      setError(err.message || '清除失败');
    } finally {
      setBusyProvider('');
    }
  };

  return <section className="desktop-model-config" aria-label="桌面版模型配置">
    <div className="desktop-model-heading"><div><p className="eyebrow">MACOS SECURE SETTINGS</p><h3>桌面版模型配置</h3><p>API Key 只保存在本机安全存储，不会进入网页或 Cochpia 数据导出。</p></div><span className={`desktop-secure-badge${config?.secureStorage ? ' ready' : ''}`}>{config?.secureStorage ? 'Keychain 加密' : '安全存储不可用'}</span></div>
    {config?.secureStorage === false && <p className="desktop-model-warning">当前系统安全存储不可用，应用不会把明文 API Key 写入磁盘。</p>}
    {notice && <p className="desktop-model-notice" role="status">{notice}</p>}
    {error && <p className="desktop-model-error" role="alert">{error}</p>}
    <div className="desktop-active-model"><label>当前桌面默认供应商<select value={activeProvider} onChange={event => setActiveProvider(event.target.value)}>{providers.map(provider => <option key={provider.provider} value={provider.provider}>{provider.label}</option>)}</select></label><button type="button" className="text-button" onClick={() => desktop.openDataFolder()}>打开数据目录</button></div>
    <div className="desktop-provider-list">{providers.filter(provider => provider.provider !== 'mock').map(provider => {
      const saved = config?.providers?.[provider.provider] || {};
      const draft = drafts[provider.provider] || {};
      const busy = busyProvider === provider.provider;
      return <article className={`desktop-provider-card${activeProvider === provider.provider ? ' active' : ''}`} key={provider.provider}><div className="desktop-provider-card-head"><div><strong>{provider.label}</strong><span className={saved.configured ? 'configured' : ''}>{saved.configured ? `已配置 ${saved.keyHint}` : '未配置'}</span></div><button type="button" className="text-button" onClick={() => setActiveProvider(provider.provider)}>{activeProvider === provider.provider ? '当前默认' : '设为默认'}</button></div><div className="desktop-provider-fields"><label>API Key<input type="password" value={draft.apiKey} onChange={event => updateDraft(provider.provider, 'apiKey', event.target.value)} placeholder={saved.configured ? `留空保持 ${saved.keyHint}` : '粘贴 API Key'} autoComplete="new-password" /></label><label>模型<input value={draft.model} onChange={event => updateDraft(provider.provider, 'model', event.target.value)} placeholder={provider.suggestedModels?.[0] || '模型名'} /></label><label>API 地址<input value={draft.apiURL} onChange={event => updateDraft(provider.provider, 'apiURL', event.target.value)} placeholder="兼容 OpenAI 的 Chat Completions 地址" /></label></div><div className="desktop-provider-actions"><button type="button" className="select-model" disabled={busy || config?.secureStorage === false} onClick={() => save(provider.provider)}>{busy ? '保存并重启…' : '保存并启用'}</button>{saved.configured && <button type="button" className="text-button muted-button" disabled={busy} onClick={() => clearKey(provider.provider)}>清除 Key</button>}</div></article>;
    })}</div>
    <p className="settings-note">Mock 供应商始终可用，适合不配置云端 Key 时进行本地验收。保存云端供应商后，本地 API 会自动重启并加载新配置。</p>
  </section>;
}

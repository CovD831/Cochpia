// Auto Memory v1:启发式判断一条用户消息是否值得沉淀为长期记忆。
export function shouldRemember(text) {
  const value = String(text || '').trim();
  if (value.length < 12) return false;
  const significant = /(记住|记得|喜欢|讨厌|重要|承诺|约定|生日|纪念|想要|害怕|担心|梦想|决定|计划|我希望|以后)/.test(value);
  return value.length >= 40 || significant;
}

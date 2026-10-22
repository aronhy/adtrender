export type HookInput = {
  product: string;
  audience: string;
  benefit: string;
  language: 'zh-CN' | 'en';
};
export type Hook = { id: string; category: string; text: string };
export type HookField = 'product' | 'audience' | 'benefit';
export type HookFieldErrors = Partial<Record<HookField, string>>;

const labels: Record<HookField, string> = { product: '产品', audience: '目标受众', benefit: '核心卖点' };
const fields: HookField[] = ['product', 'audience', 'benefit'];
type Template = { category: string; text: (input: HookInput) => string };

// Original, deterministic sentence starters. They make no claim to research,
// translation, measured performance, testimonials or model generation.
const templates: Record<HookInput['language'], Template[]> = {
  'zh-CN': [
    { category: '提问', text: ({ product, audience, benefit }) => `如果你是${audience}，挑选${product}时，会把「${benefit}」放在什么位置？` },
    { category: '场景', text: ({ product, audience, benefit }) => `${audience}的日常里，${product}的「${benefit}」可以用在哪个场景？` },
    { category: '换个角度', text: ({ product, audience, benefit }) => `看${product}，也可以换个角度：从${audience}在意的「${benefit}」开始。` },
    { category: '选购清单', text: ({ product, audience, benefit }) => `给${audience}的${product}选购清单，先记下这一项：${benefit}。` },
    { category: '细节', text: ({ product, audience, benefit }) => `聊聊${product}的一个细节：「${benefit}」对${audience}意味着什么？` },
    { category: '需求', text: ({ product, audience, benefit }) => `如果「${benefit}」正是你要的，${audience}可以从这里了解${product}。` },
    { category: '使用视角', text: ({ product, audience, benefit }) => `把自己放进${audience}的使用场景，再看看${product}的「${benefit}」。` },
    { category: '比较维度', text: ({ product, audience, benefit }) => `${audience}比较${product}时，不妨把「${benefit}」列为一个判断维度。` },
    { category: '开场邀请', text: ({ product, audience, benefit }) => `正在了解${product}的${audience}，来聊聊你是否需要「${benefit}」。` },
    { category: '选择理由', text: ({ product, audience, benefit }) => `什么让${product}适合你的日常？${audience}可以先想想「${benefit}」这件事。` },
  ],
  en: [
    { category: 'Question', text: ({ product, audience, benefit }) => `Choosing ${product} as ${audience}? Where does “${benefit}” sit on your list?` },
    { category: 'Scenario', text: ({ product, audience, benefit }) => `Picture a day in the life of ${audience}. Where could “${benefit}” from ${product} fit?` },
    { category: 'New angle', text: ({ product, audience, benefit }) => `A different way for ${audience} to look at ${product}: start with “${benefit}”.` },
    { category: 'Checklist', text: ({ product, audience, benefit }) => `Building a ${product} checklist for ${audience}? Add “${benefit}” as something to consider.` },
    { category: 'Detail', text: ({ product, audience, benefit }) => `Let's look at a detail of ${product}: what does “${benefit}” mean for ${audience}?` },
    { category: 'Need', text: ({ product, audience, benefit }) => `If “${benefit}” is on your wish list, here is a starting point for ${audience} exploring ${product}.` },
    { category: 'User perspective', text: ({ product, audience, benefit }) => `Look at ${product} through the eyes of ${audience}, with “${benefit}” in mind.` },
    { category: 'Comparison', text: ({ product, audience, benefit }) => `Comparing ${product} options for ${audience}? Make “${benefit}” part of the conversation.` },
    { category: 'Invitation', text: ({ product, audience, benefit }) => `For ${audience} curious about ${product}: let's explore whether “${benefit}” fits your needs.` },
    { category: 'Choice', text: ({ product, audience, benefit }) => `What belongs in your everyday routine? For ${audience}, consider ${product} and “${benefit}”.` },
  ],
};

export function validateHookInput(input: HookInput): HookFieldErrors {
  const errors: HookFieldErrors = {};
  for (const field of fields) {
    if (!input[field].trim()) errors[field] = `请输入${labels[field]}。`;
    else if (Array.from(input[field]).length > 200) errors[field] = `${labels[field]}最多 200 字符。`;
  }
  return errors;
}

export function generateHooks(input: HookInput): Hook[] {
  const errors = validateHookInput(input);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(' '));
  if (input.language !== 'zh-CN' && input.language !== 'en') throw new Error('请选择支持的输出语言。');
  const normalized = { ...input, product: input.product.trim(), audience: input.audience.trim(), benefit: input.benefit.trim() };
  return templates[input.language].map((template, index) => ({
    id: `${input.language}-${index + 1}`,
    category: template.category,
    text: template.text(normalized),
  }));
}

import { useState, type FormEvent } from 'react';
import { CopyResultButton } from './CopyResultButton';
import { ClientToolForm } from './ClientToolForm';
import { generateHooks, validateHookInput, type Hook, type HookField, type HookFieldErrors, type HookInput } from './hooks';

const emptyInput: HookInput = { product: '', audience: '', benefit: '', language: 'zh-CN' };
const fields: { name: HookField; label: string; placeholder: string }[] = [
  { name: 'product', label: '产品', placeholder: '例如：便携咖啡杯' },
  { name: 'audience', label: '目标受众', placeholder: '例如：每天坐地铁的通勤者' },
  { name: 'benefit', label: '核心卖点', placeholder: '例如：单手开合，方便随身携带' },
];

export function HookTool() {
  const [input, setInput] = useState<HookInput>(emptyInput);
  const [errors, setErrors] = useState<HookFieldErrors>({});
  const [hooks, setHooks] = useState<Hook[]>([]);

  function change(field: keyof HookInput, value: string) {
    setInput(current => ({ ...current, [field]: value }));
    setErrors({});
    setHooks([]);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateHookInput(input);
    setErrors(nextErrors);
    const firstError = fields.find(field => nextErrors[field.name]);
    if (firstError) {
      setHooks([]);
      event.currentTarget.querySelector<HTMLTextAreaElement>(`[name="${firstError.name}"]`)?.focus();
      return;
    }
    setHooks(generateHooks(input));
  }
  function reset() {
    setInput(emptyInput);
    setErrors({});
    setHooks([]);
  }

  return <>
    <p className="tool-note">模板生成：使用原创固定句式，不调用 AI 模型。请按输出语言填写；输入不会自动翻译，产品卖点由你核实。</p>
    <ClientToolForm className="tool-form" onSubmit={submit} onReset={reset} noValidate autoComplete="off" data-clarity-mask="true">
      <div className="tool-grid">
        {fields.map(field => <div className="tool-field" key={field.name}>
          <label htmlFor={`hook-${field.name}`}>{field.label} <span>（必填，最多 200 字符）</span></label>
          <textarea id={`hook-${field.name}`} name={field.name} value={input[field.name]} rows={3}
            placeholder={field.placeholder} required aria-invalid={Boolean(errors[field.name])}
            aria-describedby={errors[field.name] ? `hook-${field.name}-error` : undefined}
            onChange={event => change(field.name, event.target.value)} />
          {errors[field.name] && <p className="tool-error" id={`hook-${field.name}-error`} role="alert">{errors[field.name]}</p>}
        </div>)}
        <div className="tool-field">
          <label htmlFor="hook-language">输出语言</label>
          <select id="hook-language" name="language" value={input.language} onChange={event => change('language', event.target.value)}>
            <option value="zh-CN">中文模板</option>
            <option value="en">English templates</option>
          </select>
        </div>
      </div>
      <div className="tool-actions">
        <button type="submit">生成 10 条 Hook</button>
        <button type="reset">重置</button>
      </div>
    </ClientToolForm>
    {hooks.length > 0 && <section className="tool-results" aria-label="生成的 Hook" aria-live="polite" data-clarity-mask="true">
      <div className="tool-actions">
        <h2>10 条模板开头</h2>
        <CopyResultButton text={hooks.map((hook, index) => `${index + 1}. [${hook.category}] ${hook.text}`).join('\n\n')} label="复制全部" />
      </div>
      <ol className="tool-hook-list">
        {hooks.map(hook => <li className="tool-result" key={hook.id}>
          <small>{hook.category}</small>
          <p>{hook.text}</p>
          <CopyResultButton text={hook.text} label="复制这条" />
        </li>)}
      </ol>
    </section>}
  </>;
}

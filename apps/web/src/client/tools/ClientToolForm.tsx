import { useSyncExternalStore, type ComponentPropsWithRef } from 'react';

const noopSubscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Native form submission must remain unavailable until React can prevent it. */
export function ClientToolForm({ children, ...props }: ComponentPropsWithRef<'form'>) {
  const hydrated = useSyncExternalStore(noopSubscribe, clientSnapshot, serverSnapshot);
  return <form {...props}>
    <fieldset disabled={!hydrated}>{children}</fieldset>
    <noscript><p className="tool-note">请启用 JavaScript 使用此工具，输入处理在当前浏览器内完成。</p></noscript>
  </form>;
}

import { useState, type FormEvent } from 'react';
import { rememberHomeSearchIntent } from '../home-search-intent';
import { CopyResultButton } from './CopyResultButton';
import { ClientToolForm } from './ClientToolForm';
import { adFinderLinks, adFinderPlatforms, adFinderQueryError, type AdFinderPlatform } from './ad-finder';

type Search = { query: string; platform: AdFinderPlatform };

export function AdFinderTool() {
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState<AdFinderPlatform>('meta');
  const [error, setError] = useState('');
  const [search, setSearch] = useState<Search | null>(null);
  const links = search ? adFinderLinks(search.query, search.platform) : [];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = adFinderQueryError(query);
    if (validationError) {
      setError(validationError);
      setSearch(null);
      event.currentTarget.querySelector('input')?.focus();
      return;
    }
    setError('');
    setSearch({ query: query.trim(), platform });
  }
  function reset() {
    setQuery('');
    setPlatform('meta');
    setError('');
    setSearch(null);
  }

  return <>
    <p className="tool-note">选择平台，获取官方广告库入口。官方入口不自动填入关键词，可复制后在平台内搜索。</p>
    <ClientToolForm className="tool-form" onSubmit={submit} onReset={reset} noValidate autoComplete="off" data-clarity-mask="true">
      <div className="tool-grid">
        <div className="tool-field">
          <label htmlFor="ad-finder-query">品牌或关键词 <span>（必填，最多 200 字符）</span></label>
          <input id="ad-finder-query" name="query" type="text" value={query} placeholder="例如：运动鞋或品牌名称" required
            aria-invalid={Boolean(error)} aria-describedby={error ? 'ad-finder-query-error' : undefined}
            onChange={event => { setQuery(event.target.value); setError(''); setSearch(null); }} />
          {error && <p className="tool-error" id="ad-finder-query-error" role="alert">{error}</p>}
        </div>
        <div className="tool-field">
          <label htmlFor="ad-finder-platform">广告平台</label>
          <select id="ad-finder-platform" name="platform" value={platform}
            onChange={event => { setPlatform(event.target.value as AdFinderPlatform); setError(''); setSearch(null); }}>
            {Object.entries(adFinderPlatforms).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
          </select>
        </div>
      </div>
      <div className="tool-actions">
        <button type="submit">获取广告库入口</button>
        <button type="reset">重置</button>
      </div>
    </ClientToolForm>
    {search && links.length > 0 && <section className="tool-results" aria-label="广告库入口" aria-live="polite" data-clarity-mask="true">
      <div className="tool-actions">
        <h2>搜索关键词：{search.query}</h2>
        <CopyResultButton text={search.query} label="复制关键词" />
      </div>
      <ul className="tool-link-list">
        {links.map(link => <li className="tool-result" key={link.kind}>
          {link.kind === 'official'
            ? <><h3>平台官方广告库</h3><p>无需 AdTrender 账号。平台的登录、地区及收录范围以官方规则为准。</p>
              <a href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{link.label}</a></>
            : <><h3>AdTrender 已收录广告</h3><p>在现有工作区内搜索已收录数据，需登录并具备工作区及对应来源权限。</p>
              <a href={link.url} onClick={() => rememberHomeSearchIntent(new URLSearchParams({ q: search.query, platform: adFinderPlatforms[search.platform].workspacePlatform }))}>{link.label}</a></>}
        </li>)}
      </ul>
    </section>}
  </>;
}

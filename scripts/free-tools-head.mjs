/** Wasp supplies a default title/description before React hoists route metadata.
 * Keep the route's final tags on prerendered tool pages; leave the SPA fallback
 * and other public pages alone.
 */
export function freeToolsHead(paths) {
  return {
    name: 'adtrender:free-tools-head',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!paths.includes(context.path.replace(/\/index\.html$/, ''))) return html;
        return html.replace(/<head\b[^>]*>([\s\S]*?)<\/head>/i, (head, content) => {
          let result = content;
          for (const pattern of [/<title\b[^>]*>[\s\S]*?<\/title>/gi, /<meta\b[^>]*\bname=["']description["'][^>]*>/gi]) {
            let count = [...result.matchAll(pattern)].length;
            if (!count) throw new Error('FREE_TOOLS_METADATA_MISSING');
            result = result.replace(pattern, tag => --count === 0 ? tag : '');
          }
          return head.replace(content, result);
        });
      },
    },
  };
}

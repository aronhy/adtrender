import './interactions.css';
/** Product-owned implementation. Bencho is a visual reference; no upstream code is embedded. */
export function MediaPlaceholder() {
  return (
    <div className="ui-media-placeholder" aria-hidden="true">
      <span className="ui-media-placeholder-mark" />
      <span className="ui-media-placeholder-line" />
    </div>
  );
}

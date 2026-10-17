import { useId, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import './interactions.css';
export function FaqAccordion({
  items,
  defaultOpen = -1,
}: {
  items: { question: string; answer: ReactNode }[];
  defaultOpen?: number;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ui-faq">
      {items.map((item, index) => (
        <section
          className="ui-faq-item"
          key={item.question}
          data-open={open === index}
        >
          <h3>
            <button
              type="button"
              id={`${id}-${index}-question`}
              aria-expanded={open === index}
              aria-controls={`${id}-${index}-answer`}
              onClick={() => setOpen(open === index ? -1 : index)}
            >
              <span>{item.question}</span>
              <Plus size={18} aria-hidden="true" />
            </button>
          </h3>
          <div
            className="ui-faq-answer"
            id={`${id}-${index}-answer`}
            role="region"
            aria-labelledby={`${id}-${index}-question`}
            aria-hidden={open !== index}
            inert={open !== index}
          >
            <div>
              <div className="ui-faq-answer-content">{item.answer}</div>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

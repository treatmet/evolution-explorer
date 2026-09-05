import { useCallback, useEffect, useRef, useState } from 'react';

import type { DescriptionSegment } from '@evo-tree/domain';

interface ArticlePreview {
  title: string;
  extract: string;
  thumbnailUrl?: string;
}

const previewCache = new Map<string, ArticlePreview | null>();

interface LinkedDescriptionProps {
  description: string;
  segments?: ReadonlyArray<DescriptionSegment>;
  sourceLabel?: string;
  sourceUrl?: string;
}

export function LinkedDescription({
  description,
  segments,
  sourceLabel,
  sourceUrl
}: LinkedDescriptionProps) {
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArticlePreview | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  const showPreview = useCallback((title: string) => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    setActiveTitle(title);

    const cached = previewCache.get(title);
    if (cached !== undefined) {
      setPreview(cached);
      return;
    }

    setPreview(null);
    fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: Record<string, unknown> | null) => {
        const extract = typeof data?.['extract'] === 'string' ? (data['extract'] as string) : '';
        const thumbnail = data?.['thumbnail'] as { source?: string } | undefined;
        const value: ArticlePreview | null = extract
          ? {
              title: typeof data?.['title'] === 'string' ? (data['title'] as string) : title,
              extract,
              ...(thumbnail?.source ? { thumbnailUrl: thumbnail.source } : {})
            }
          : null;

        previewCache.set(title, value);
        setActiveTitle((current) => {
          if (current === title) {
            setPreview(value);
          }
          return current;
        });
      })
      .catch(() => {
        previewCache.set(title, null);
      });
  }, []);

  const scheduleHide = useCallback(() => {
    hideTimerRef.current = window.setTimeout(() => {
      setActiveTitle(null);
      setPreview(null);
    }, 180);
  }, []);

  if (!segments || segments.length === 0) {
    return (
      <>
        <p className="decision-description">{description}</p>
        <DescriptionAttribution label={sourceLabel} url={sourceUrl} />
      </>
    );
  }

  return (
    <>
      <p className="decision-description">
      {segments.map((segment, index) => {
        if (!segment.href || !segment.articleTitle) {
          return <span key={index}>{segment.text}</span>;
        }

        const articleTitle = segment.articleTitle;
        const isActive = activeTitle === articleTitle;

        return (
          <span key={index} className="description-link-wrapper">
            <a
              className="description-link"
              href={segment.href}
              target="_blank"
              rel="noopener noreferrer"
              onMouseEnter={() => showPreview(articleTitle)}
              onMouseLeave={scheduleHide}
              onFocus={() => showPreview(articleTitle)}
              onBlur={scheduleHide}
            >
              {segment.text}
            </a>
            {isActive ? (
              <span
                className="description-preview"
                role="tooltip"
                onMouseEnter={() => showPreview(articleTitle)}
                onMouseLeave={scheduleHide}
              >
                {preview ? (
                  <>
                    <span className="description-preview-title">{preview.title}</span>
                    {preview.thumbnailUrl ? (
                      <img
                        className="description-preview-image"
                        src={preview.thumbnailUrl}
                        alt=""
                        loading="lazy"
                      />
                    ) : null}
                    <span className="description-preview-extract">{preview.extract}</span>
                  </>
                ) : (
                  <span className="description-preview-extract">Loading preview…</span>
                )}
              </span>
            ) : null}
          </span>
        );
      })}
    </p>
      <DescriptionAttribution label={sourceLabel} url={sourceUrl} />
    </>
  );
}

function DescriptionAttribution({ label, url }: { label?: string; url?: string }) {
  if (!label) {
    return null;
  }

  return (
    <p className="decision-description-source">
      Described by Wikipedia article{' '}
      {url ? (
        <a className="description-link" href={url} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
    </p>
  );
}

import type { JSX, ReactNode } from "react";
import "./FilterSection.css";

export type FilterSectionProps = {
  readonly title: string;
  readonly activeCount: number;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
};

/** A permanent filter group whose controls stay visible while the dialog is open. */
export function FilterSection({ title, activeCount, children }: FilterSectionProps): JSX.Element {
  const section = title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return (
    <section className="archer-filter-section" data-section={section}>
      <h3>
        <span className="archer-filter-section-title">{title}</span>
        {activeCount > 0 ? <span className="archer-filter-section-count">{activeCount} active</span> : null}
      </h3>
      <div className="archer-filter-section-grid">{children}</div>
    </section>
  );
}

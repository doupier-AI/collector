export interface MarkdownPositionFixtureRange {
  readonly start: number;
  readonly end: number;
}

export interface MarkdownPositionFixture {
  readonly trigger: string;
  readonly body: string;
  readonly heading: string;
  readonly selection: {
    readonly exact: string;
    readonly occurrence: number;
    readonly sourceRange: MarkdownPositionFixtureRange;
  };
  readonly citation: {
    readonly token: string;
    readonly sourceTitle: string;
    readonly sourceUrl: string;
  };
  readonly term: { readonly exact: string };
  readonly search: {
    readonly exact: string;
    readonly sourceRange: MarkdownPositionFixtureRange;
  };
  readonly chapter: { readonly title: string };
  readonly formula: { readonly valid: string; readonly invalid: string };
}

export const MARKDOWN_POSITION_FIXTURE: MarkdownPositionFixture;

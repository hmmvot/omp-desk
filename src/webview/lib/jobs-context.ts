import { createContext, useSyncExternalStore } from "react";
import type { JobsView } from "../../chat/background-jobs";
import type { JobsUi, JobsUiState } from "./jobs-ui";

/**
 * What the Jobs row, the working row, the tool cards and the `proc://` links of one Chat page read: the jobs the model shows, the
 * page's {@link JobsUi}, and why a cancel is not offered right now (null when it is). Absent where the page has no Jobs row (a detail
 * tab, a static render): the surfaces then draw no chip, no Cancel and no link.
 */
export interface JobsContextValue {
	view: JobsView;
	ui: JobsUi;
	cancelBlocked: string | null;
}

export const JobsContext = createContext<JobsContextValue | null>(null);

const NO_SUBSCRIBE = (): (() => void) => () => undefined;
/** What a page without a Jobs row reads. */
const IDLE: JobsUiState = { focus: null, pending: null, outcome: null, gone: new Map() };
const getIdle = (): JobsUiState => IDLE;

/** The page's request to show a job, the cancel that is open and the last outcome; re-renders on each change. Idle without a {@link JobsUi}. */
export function useJobsUiState(ui: JobsUi | null): JobsUiState {
	return useSyncExternalStore(ui?.subscribe ?? NO_SUBSCRIBE, ui?.getState ?? getIdle);
}

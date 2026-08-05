// Job-domain types shared across the app. The job DETAIL VIEW payload
// (FocusedJobView) lives with its loader in views/getFocusedJob.ts; what stays
// here is the shape the drafting artifacts, the API routes, and the panel all
// spell independently of any one screen.

export type ShortAnswer = { question: string; answer: string };

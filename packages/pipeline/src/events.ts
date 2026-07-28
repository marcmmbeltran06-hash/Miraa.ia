export interface PipelineStarted {
  type: 'PipelineStarted';
  payload: {
    entryUrl: string;
  };
}

export interface PipelineCompleted {
  type: 'PipelineCompleted';
  payload: {
    entryUrl: string;
    visitedPages: number;
  };
}

export interface PipelineFailed {
  type: 'PipelineFailed';
  payload: {
    entryUrl: string;
    reason: string;
    error?: unknown;
  };
}

export type PipelineEvent = PipelineStarted | PipelineCompleted | PipelineFailed;

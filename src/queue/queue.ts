interface UsernameJob {
  username: string;
}

interface MockQueue {
  add(name: string, data: UsernameJob): Promise<{ id: string }>;
}

interface MockWorker {
  on(event: string, callback: unknown): void;
}

const githubPipelineQueue: MockQueue = {
  add: async () => ({ id: 'mock' }),
};

const worker: MockWorker = {
  on: () => {
    // no-op
  },
};

console.log('Queue module initialized in mock mode (Redis removed)');

export { githubPipelineQueue, worker };
export type { UsernameJob };

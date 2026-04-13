// Basic CLI entry point
import { config } from './utils/config.js';
import { githubPipelineQueue } from './queue/queue.js';

async function main() {
  console.log('github-data-pipeline started!');
  console.log('Environment Configuration:');
  console.log(`- Node Env: ${config.nodeEnv}`);
  console.log(`- Database URL: ${config.databaseUrl}`);
  console.log(`- Number of GitHub tokens: ${config.githubTokens.length}`);

  // Start the worker (it's already configured to listen for jobs)
  // In a real app, you might want to start the worker in a separate process
  // or manage its lifecycle more explicitly. For this setup, importing it
  // and having it listen is sufficient for infrastructure.
  console.log('BullMQ worker is running...');

  // --- Example of adding a job ---
  // You can add jobs to the queue here or from other modules.
  // In a real application, this would likely be triggered by an API request or another event.

  try {
    console.log('Adding example jobs to the queue...');

    const job1 = await githubPipelineQueue.add('processUser', { username: 'octocat' });
    console.log(`Added job ${job1.id} to process user: octocat`);

    const job2 = await githubPipelineQueue.add('processUser', { username: 'testuser123' });
    console.log(`Added job ${job2.id} to process user: testuser123`);

    // Example of a job that will fail and retry
    const job3 = await githubPipelineQueue.add('processUser', { username: 'fail-me' });
    console.log(`Added job ${job3.id} to process user: fail-me (expected to fail and retry)`);

    // Example with a specific job name (first argument to add)
    const job4 = await githubPipelineQueue.add('processAnotherUser', { username: 'anotheruser' });
    console.log(`Added job ${job4.id} with custom name 'processAnotherUser' for user: anotheruser`);
  } catch (error) {
    console.error('Failed to add jobs to the queue:', error);
  }

  // For a long-running process, you might want to keep the CLI running.
  // For demonstration purposes, we'll let it exit after adding jobs and starting the worker.
  // In a production scenario, the worker would typically run independently or the process
  // would be managed by a process manager like PM2.

  // Optional: Graceful shutdown logic could be added here.
  // e.g., process.on('SIGINT', async () => { ... });
}

main().catch((error) => {
  console.error('Error in main execution:', error);
  process.exit(1);
});

import Docker from 'dockerode';
import { Writable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs/promises';

const docker = new Docker();

async function executeCode(script: string, csvFilePath: string): Promise<{ stdout: string, stderr: string, visualOutputs?: string[] }> {
  try {
    // Path inside the container where the CSV file will be accessible
    const containerCsvPath = '/data/input.csv';
    const containerOutputDir = '/data/output';
    const hostOutputDir = join(tmpdir(), 'code_execution_output');

    // Create a Python container with enhanced security settings
    const container = await docker.createContainer({
      Image: 'python:3.9-slim',
      Cmd: ['python', '-c', script],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        NetworkMode: 'none',                  // No network
        ReadonlyRootfs: true,                 // Read-only filesystem
        CapDrop: ['all'],                     // Drop all capabilities
        Memory: 50 * 1024 * 1024,             // Limit to 50MB of RAM
        PidsLimit: 100,                       // Limit number of processes
        // Mount the CSV file from the host into the container
        Binds: [
          `${csvFilePath}:${containerCsvPath}:ro`,
          `${hostOutputDir}:${containerOutputDir}`
        ],  // 'ro' makes it read-only
      }
    });
    console.log(container, 'container')
    // Attach to the container
    const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      container.attach({ stream: true, stdout: true, stderr: true }, (err, stream) => {
        if (err) reject(err);
        else resolve(stream!);
      });
    });

    let stdout = '';
    let stderr = '';
    const stdoutStream = new Writable({
      write(chunk, encoding, callback) {
          stdout += chunk.toString();
          callback();
      }
    });

    const stderrStream = new Writable({
      write(chunk, encoding, callback) {
        stderr += chunk.toString();
        callback();
      }
    });

    container.modem.demuxStream(stream, stdoutStream, stderrStream);

    // Start the container with a timeout
    // Start the container with a timeout
    const TIMEOUT = 10000;  // 10 seconds
    const timeout = new Promise<{ stdout: string, stderr: string }>((_, reject) => 
      setTimeout(() => reject(new Error("Code execution timed out")), TIMEOUT)
    );

    const startAndCleanup = new Promise<{ stdout: string, stderr: string, visualOutputs?: string[] }>(resolve => {
      stream.on('end', async () => {
        // After execution, check if there are any files in `hostOutputDir` and handle them.
        const files = await fs.readdir(hostOutputDir);
        const visualOutputs: string[] = [];

        for (const file of files) {
          const visualOutputPath = join(hostOutputDir, file);
          const visualOutputBuffer = await fs.readFile(visualOutputPath);
          const encodedOutput = visualOutputBuffer.toString('base64');
          visualOutputs.push(encodedOutput);
          
          // Optional: remove the file after reading to clean up
          await fs.unlink(visualOutputPath);
        }

        await container.remove();
        resolve({ stdout, stderr, visualOutputs });
      });
      container.start();
    });

    return await Promise.race([timeout, startAndCleanup]);

  } catch (error) {
    console.log(error);
    throw error;
  }
}

export default executeCode;
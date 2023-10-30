import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

export default function streamPythonCode(pythonCode: string, pythonInterpreter: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pythonProcess: ChildProcess = spawn(pythonInterpreter, ['-u', '-c', pythonCode]);

    if (pythonProcess.stderr) {
      pythonProcess.stderr.on('data', (data: Buffer) => {
        console.error('Python Error:', data.toString());
      });
    } else {
      console.error('Failed to attach stderr stream');
    }

    if (pythonProcess.stdout) {
      const rl = readline.createInterface({
        input: pythonProcess.stdout,
        crlfDelay: Infinity
      });

      rl.on('line', (line: string) => {
        console.log('Python Output:', line);
      });

      pythonProcess.on('exit', (code: number | null) => {
        rl.close();
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Python process exited with code ${code}`));
        }
      });
    } else {
      console.error('Failed to attach stdout stream');
      reject(new Error('Failed to attach stdout stream'));
    }
  });
}

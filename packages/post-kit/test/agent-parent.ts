import { PrivateAgent } from '../src/signing.ts';

const keyFile = process.argv[2];
if (keyFile === undefined) throw new Error('throwaway key is required');
const agent = await PrivateAgent.start({ keyFile, askPassphrase: () => '' });
process.stdout.write(
  `${JSON.stringify({ socket: agent.env.SSH_AUTH_SOCK, pid: Number(agent.env.SSH_AGENT_PID) })}\n`,
);
setInterval(() => {}, 1000);

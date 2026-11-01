#!/usr/bin/env node
// Stand-in for the docker command. Keeps its containers in $FAKE_DOCKER_STATE (JSON) and records every call.
import fs from 'node:fs';
const file = process.env.FAKE_DOCKER_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { calls: [], containers: [] };
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const find = (n) => state.containers.find((c) => c.name === n);
const [cmd] = args;
if (cmd === 'version') {
  save();
  if (process.env.FAKE_DOCKER_DOWN) {
    console.error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
    process.exit(1);
  }
  console.log('28.1.1');
} else if (cmd === 'context') {
  console.log('orbstack');
} else if (cmd === 'ps') {
  const label = args[args.indexOf('--filter') + 1].replace(/^label=/, '');
  for (const c of state.containers.filter((c) => c.labels.includes(label))) {
    console.log(JSON.stringify({ Names: c.name, Image: c.image, State: c.state, Status: c.state === 'running' ? 'Up 2 minutes' : 'Exited (0) 1 minute ago', Ports: c.ports, Labels: c.labels.join(',') }));
  }
} else if (cmd === 'run') {
  const name = args[args.indexOf('--name') + 1];
  if (find(name)) {
    console.error(`Conflict. The container name "/${name}" is already in use`);
    process.exit(125);
  }
  const labels = args.flatMap((a, i) => (args[i - 1] === '--label' ? [a] : []));
  const pub = args[args.indexOf('--publish') + 1].split(':');
  console.error(`Unable to find image '${args.at(-1)}' locally`);
  console.error('Status: Downloaded newer image');
  state.containers.push({ name, image: args.at(-1), state: 'running', labels, ports: `${pub[0]}:${pub[1]}->${pub[2]}/tcp`, args });
  console.log('f'.repeat(64));
} else if (cmd === 'start' || cmd === 'stop') {
  const c = find(args.at(-1));
  if (!c) process.exit(1);
  c.state = cmd === 'start' ? 'running' : 'exited';
} else if (cmd === 'rm') {
  state.containers = state.containers.filter((c) => c.name !== args.at(-1));
} else if (cmd === 'logs') {
  console.log(`hello from ${args.at(-1)}`);
  console.error('a warning on stderr');
} else process.exit(2);
save();

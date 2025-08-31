import { execa } from "execa";

export async function checkEnv() {
  let dockerAvailable = false;
  try {
    await execa("docker", ["--version"]);
    dockerAvailable = true;
  } catch {}

  let awsCliAvailable = false;
  try {
    await execa("aws", ["--version"]);
    awsCliAvailable = true;
  } catch {}

  const nodeVersion = process.version;
  console.log(JSON.stringify({ dockerAvailable, awsCliAvailable, nodeVersion }, null, 2));
}


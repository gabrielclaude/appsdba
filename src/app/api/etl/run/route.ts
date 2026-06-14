import { auth } from "@clerk/nextjs/server";
import { spawn } from "child_process";
import path from "path";

export const runtime = "nodejs";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const scriptDir = process.env.ETL_SCRIPT_DIR;
  if (!scriptDir) {
    return Response.json(
      { error: "ETL_SCRIPT_DIR is not set — ETL can only be triggered from the local dev machine." },
      { status: 503 }
    );
  }

  const pythonExe = path.join(scriptDir, ".venv", "Scripts", "python.exe");

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const proc = spawn(pythonExe, ["main.py", "etl"], {
        cwd: scriptDir,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });

      proc.stdout.on("data", (d: Buffer) => controller.enqueue(enc.encode(d.toString())));
      proc.stderr.on("data", (d: Buffer) => controller.enqueue(enc.encode(d.toString())));

      proc.on("close", (code) => {
        controller.enqueue(enc.encode(`\n[exit ${code}]`));
        controller.close();
      });

      proc.on("error", (err) => {
        controller.enqueue(enc.encode(`\n[error] ${err.message}`));
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

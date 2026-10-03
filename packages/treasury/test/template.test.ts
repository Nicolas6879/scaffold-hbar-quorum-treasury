import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const templatePath = resolve(root, "template.json");

// template.json only exists in the template repo; create-scaffold-hbar consumes it when scaffolding.
describe.skipIf(!existsSync(templatePath))("template.json", () => {
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  const block = template["create-scaffold-hbar"];
  const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts as Record<string, string>;

  it("defaults to foundry + yarn, the CLI's fallback when the manifest cannot be fetched", () => {
    expect(block.defaults).toMatchObject({ solidityFramework: "foundry", packageManager: "yarn", frontend: "nextjs-app" });
    expect(block.capabilities.solidityFramework).toEqual(["foundry"]);
    expect(block.capabilities.packageManager).toEqual(expect.arrayContaining(["yarn", "npm"]));
  });

  it("every {run:…} in the outro points at a real root script", () => {
    const commands: string[] = block.outro.sections.flatMap((s: { steps: { command?: string }[] }) =>
      s.steps.flatMap(step => (step.command ? [step.command] : [])),
    );
    const referenced = commands.flatMap(c => [...c.matchAll(/\{run:([a-zA-Z0-9:_-]+)\}/g)].map(m => m[1]!));
    expect(referenced.length).toBeGreaterThan(3);
    for (const script of referenced) {
      const name = script.replace(/^framework:/, "foundry:");
      expect(scripts, `missing root script "${name}"`).toHaveProperty(name);
    }
  });

  it("declares every env var the scripts read", () => {
    const keys = block.envVars.map((v: { key: string }) => v.key);
    expect(keys).toEqual(expect.arrayContaining(["OPERATOR_ID", "OPERATOR_KEY", "NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID"]));
  });
});

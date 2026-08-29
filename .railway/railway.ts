import { defineRailway, github, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("t3code-f2e76892-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-east4-eqdc4a",
    sizeMB: 50000,
  });

  const executor = service("Executor Fork", {
    source: github("TheLiberal/executor", { branch: "main" }),
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    replicas: { "us-east4-eqdc4a": 1 },
    networking: { privateNetworkEndpoint: "t3code-f2e76892" },
    volumeMounts: { "/data": data },
  });

  return project("Executor Fork", {
    resources: [executor, data],
  });
});

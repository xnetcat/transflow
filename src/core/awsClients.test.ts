import { describe, it, expect } from "vitest";
import {
  buildS3PublicUrl,
  resolveEndpoint,
  resolveCredentials,
  resolveRegion,
} from "./awsClients";

describe("awsClients helpers", () => {
  it("buildS3PublicUrl uses AWS host without endpoint", () => {
    expect(buildS3PublicUrl("my-bucket", "outputs/foo.mp3", "eu-north-1")).toBe(
      "https://my-bucket.s3.eu-north-1.amazonaws.com/outputs/foo.mp3"
    );
  });

  it("buildS3PublicUrl routes through endpoint when set", () => {
    expect(
      buildS3PublicUrl(
        "my-bucket",
        "outputs/foo.mp3",
        "us-east-1",
        "http://localhost:4566"
      )
    ).toBe("http://localhost:4566/my-bucket/outputs/foo.mp3");
  });

  it("buildS3PublicUrl encodes keys", () => {
    expect(
      buildS3PublicUrl("b", "outputs/with space.mp3", "us-east-1")
    ).toContain("with%20space.mp3");
  });

  it("resolveEndpoint prefers cfg over env", () => {
    process.env.TRANSFLOW_AWS_ENDPOINT = "http://env-host:4566";
    try {
      expect(resolveEndpoint({ endpoint: "http://cfg-host:4566" })).toBe(
        "http://cfg-host:4566"
      );
      expect(resolveEndpoint({})).toBe("http://env-host:4566");
    } finally {
      delete process.env.TRANSFLOW_AWS_ENDPOINT;
    }
  });

  it("resolveCredentials reads env when cfg not set", () => {
    process.env.TRANSFLOW_AWS_ACCESS_KEY_ID = "k";
    process.env.TRANSFLOW_AWS_SECRET_ACCESS_KEY = "s";
    try {
      expect(resolveCredentials({})).toEqual({
        accessKeyId: "k",
        secretAccessKey: "s",
        sessionToken: undefined,
      });
    } finally {
      delete process.env.TRANSFLOW_AWS_ACCESS_KEY_ID;
      delete process.env.TRANSFLOW_AWS_SECRET_ACCESS_KEY;
    }
  });

  it("resolveRegion falls back through env to default", () => {
    const before = { ar: process.env.AWS_REGION, ad: process.env.AWS_DEFAULT_REGION };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      expect(resolveRegion()).toBe("us-east-1");
      expect(resolveRegion("eu-west-1")).toBe("eu-west-1");
      expect(resolveRegion({ region: "ap-south-1" })).toBe("ap-south-1");
    } finally {
      if (before.ar) process.env.AWS_REGION = before.ar;
      if (before.ad) process.env.AWS_DEFAULT_REGION = before.ad;
    }
  });
});

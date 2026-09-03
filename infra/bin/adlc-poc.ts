#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AdlcPocStack } from "../lib/adlc-poc-stack";

const app = new cdk.App();
new AdlcPocStack(app, "AdlcPocStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description:
    "ADLC bug-fix PoC: CodeCommit target repo, Step Functions orchestration, Kiro CLI coding agent on Bedrock AgentCore, Cognito-authenticated UI",
});

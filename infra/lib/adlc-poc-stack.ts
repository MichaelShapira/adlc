import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Auth from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Int from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";

const BASE_BRANCH = "main";
// Independent validation uses Sonnet and remains separate from the selected
// implementation engine (Kiro CLI or its Haiku fallback).
const VALIDATE_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const MAX_FIX_LOOPS = 3;
const KIRO_KEY_SECRET_NAME = "adlc-poc/kiro-api-key";

export class AdlcPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // Target repository: dummy todo app with the two seeded bugs
    // ------------------------------------------------------------------
    const repo = new codecommit.Repository(this, "TodoRepo", {
      repositoryName: "adlc-poc-todo-service",
      description:
        "ADLC PoC target repo: todo-service with BUG-001 (build break) and BUG-002 (SQL injection)",
      code: codecommit.Code.fromDirectory(
        path.join(__dirname, "..", "..", "dummy-app"),
        BASE_BRANCH
      ),
    });

    // ------------------------------------------------------------------
    // Encrypted Kiro API key placeholder. The user replaces PLACEHOLDER
    // with a real ksk_ key after deployment; no key enters CDK context or
    // CloudFormation parameters.
    // ------------------------------------------------------------------
    const kiroKeySecret = new secretsmanager.Secret(this, "KiroApiKeySecret", {
      secretName: KIRO_KEY_SECRET_NAME,
      description:
        "Kiro CLI API key (ksk_...) for the ADLC PoC coding agent. PLACEHOLDER = use Bedrock fallback.",
      secretStringValue: cdk.SecretValue.unsafePlainText("PLACEHOLDER"),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });

    // ------------------------------------------------------------------
    // Runs table
    // ------------------------------------------------------------------
    const runsTable = new dynamodb.Table(this, "RunsTable", {
      partitionKey: { name: "runId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const repoControlTable = new dynamodb.Table(this, "RepoControlTable", {
      partitionKey: { name: "repoBranch", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const resetAuditTable = new dynamodb.Table(this, "ResetAuditTable", {
      partitionKey: { name: "actionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const contextTable = new dynamodb.Table(this, "ContextTable", {
      partitionKey: { name: "ownerSub", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "itemKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const contextBucket = new s3.Bucket(this, "ContextBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedOrigins: ["*"],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedHeaders: ["content-type"],
          exposedHeaders: ["etag"],
          maxAge: 300,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
      autoDeleteObjects: true,
    });

    // ------------------------------------------------------------------
    // Coding agent on Bedrock AgentCore Runtime (Kiro CLI + fallback)
    // ------------------------------------------------------------------
    const agentImage = new ecrAssets.DockerImageAsset(this, "AgentImage", {
      directory: path.join(__dirname, "..", "..", "agent"),
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    const agentRole = new iam.Role(this, "AgentRuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
          },
        },
      }),
      description: "Execution role for the ADLC PoC coding agent runtime",
    });
    // Image pull (CDK asset ECR repo). grantPull includes all repository-scoped
    // layer/image actions; GetAuthorizationToken is necessarily resource "*".
    agentImage.repository.grantPull(agentRole);
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      })
    );
    // Logs, metrics, traces (AgentCore observability)
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
        ],
      })
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
        ],
        resources: ["*"],
      })
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" },
        },
      })
    );
    // Workload identity token (required by AgentCore runtime)
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default*`,
        ],
      })
    );
    // Task permissions: clone/push the one repo, read the Kiro key. The agent
    // runs Kiro CLI only — it has no Bedrock model access by design.
    repo.grantPullPush(agentRole);
    kiroKeySecret.grantRead(agentRole);
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [runsTable.tableArn],
      })
    );

    const agentRuntime = new agentcore.CfnRuntime(this, "CodingAgentRuntime", {
      agentRuntimeName: "adlc_poc_coding_agent",
      description:
        "ADLC PoC coding agent: Kiro CLI (headless) only; clones the todo repo, implements approved fixes, pushes fix branches",
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: agentImage.imageUri },
      },
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "HTTP",
      roleArn: agentRole.roleArn,
      environmentVariables: {
        REPO_NAME: repo.repositoryName,
        REPO_REGION: this.region,
        RUNS_TABLE: runsTable.tableName,
        KIRO_KEY_SECRET_ARN: kiroKeySecret.secretArn,
      },
    });
    // CfnRuntime references only the role ARN, so CloudFormation otherwise has
    // no dependency on the separately generated inline policy and may validate
    // ECR access before that policy is attached.
    const agentDefaultPolicy = agentRole.node.tryFindChild("DefaultPolicy");
    if (agentDefaultPolicy) {
      agentRuntime.node.addDependency(agentDefaultPolicy);
    }

    // ------------------------------------------------------------------
    // Step Lambdas
    // ------------------------------------------------------------------
    const stepEnv = {
      RUNS_TABLE: runsTable.tableName,
      REPO_NAME: repo.repositoryName,
      BASE_BRANCH,
      REPO_CONTROL_TABLE: repoControlTable.tableName,
    };
    const stepFn = (name: string, entry: string, extra?: {
      env?: Record<string, string>;
      timeout?: cdk.Duration;
      memory?: number;
    }) =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, "..", "lambdas", "steps", entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: extra?.timeout ?? cdk.Duration.minutes(2),
        memorySize: extra?.memory ?? 512,
        logRetention: logs.RetentionDays.ONE_WEEK,
        bundling: { externalModules: [], minify: true, sourceMap: false },
        environment: { ...stepEnv, ...(extra?.env ?? {}) },
      });

    const triageFn = stepFn("TriageFn", "triage.ts", {
      env: {
        CONTEXT_TABLE: contextTable.tableName,
        CONTEXT_BUCKET: contextBucket.bucketName,
      },
      memory: 1024,
    });
    const draftFn = stepFn("DraftFn", "draft.ts");
    const autoDecisionFn = stepFn("AutoDecisionFn", "auto-decision.ts");
    const awaitApprovalFn = stepFn("AwaitApprovalFn", "await-approval.ts");
    const implementFn = stepFn("ImplementFn", "implement.ts", {
      env: { AGENT_RUNTIME_ARN: agentRuntime.attrAgentRuntimeArn },
      timeout: cdk.Duration.minutes(15),
      memory: 1024,
    });
    const validateFn = stepFn("ValidateFn", "validate.ts", {
      env: { VALIDATE_MODEL_ID },
    });
    const reportFn = stepFn("ReportFn", "report.ts");
    const securityStartFn = stepFn("SecurityStartFn", "security-review-start.ts", {
      timeout: cdk.Duration.minutes(5),
      memory: 1024,
    });
    const securityCheckFn = stepFn("SecurityCheckFn", "security-review-check.ts", {
      timeout: cdk.Duration.minutes(2),
    });
    for (const fn of [securityStartFn, securityCheckFn]) {
      fn.addEnvironment("AGENT_SPACE_ID", "as-6b6ad79c-b406-4765-aa20-7e8a904e6f9e");
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["securityagent:*"],
        resources: ["*"],
      }));
    }
    securityStartFn.addEnvironment("SERVICE_ROLE_ARN", "arn:aws:iam::703091483751:role/service-role/security-testing-20260914113135");
    securityStartFn.addEnvironment("CONTEXT_BUCKET", contextBucket.bucketName);
    contextBucket.grantReadWrite(securityStartFn);
    repo.grantRead(securityStartFn);
    // APP_ENDPOINT set after CloudFront distribution is created (see below)

    for (const fn of [triageFn, draftFn, autoDecisionFn, awaitApprovalFn, implementFn, validateFn, reportFn, securityStartFn, securityCheckFn]) {
      runsTable.grantReadWriteData(fn);
    }
    const bedrockInvoke = new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.*`,
      ],
    });
    triageFn.addToRolePolicy(bedrockInvoke);
    draftFn.addToRolePolicy(bedrockInvoke);
    validateFn.addToRolePolicy(bedrockInvoke);
    repo.grantRead(triageFn);
    triageFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [contextTable.tableArn],
      })
    );
    triageFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${contextBucket.bucketArn}/users/*`],
      })
    );
    repo.grantRead(draftFn);
    repo.grantRead(validateFn);
    repo.grantRead(implementFn);
    repo.grantRead(securityStartFn);
    repoControlTable.grantReadWriteData(implementFn);
    implementFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          agentRuntime.attrAgentRuntimeArn,
          `${agentRuntime.attrAgentRuntimeArn}/*`,
        ],
      })
    );

    // ------------------------------------------------------------------
    // Workflow v2: triage recommendation -> generate both artifacts -> optional
    // automatic SIMPLE approval or human execution gate -> implement -> validate
    // -> (fix loop, max 3) -> report. COMPLEX fixes always use the human gate.
    // The approved artifact remains frozen for every implementation retry.
    // ------------------------------------------------------------------
    const triage = new tasks.LambdaInvoke(this, "Triage", {
      lambdaFunction: triageFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "analysisModel.$": "$.analysisModel",
        "triageInstruction.$": "$.triageInstruction",
        "ownerSub.$": "$.ownerSub",
        "includeContext.$": "$.includeContext",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.triage",
    });

    const draft = new tasks.LambdaInvoke(this, "Draft", {
      lambdaFunction: draftFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "analysisModel.$": "$.analysisModel",
        "triage.$": "$.triage",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.draft",
    });

    const autoDecision = new tasks.LambdaInvoke(this, "AutoDecision", {
      lambdaFunction: autoDecisionFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "draft.$": "$.draft",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.approval",
    });

    const awaitApproval = new tasks.LambdaInvoke(this, "AwaitApproval", {
      lambdaFunction: awaitApprovalFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        taskToken: sfn.JsonPath.taskToken,
      }),
      resultPath: "$.approval",
      taskTimeout: sfn.Timeout.duration(cdk.Duration.hours(24)),
    });

    const implement = new tasks.LambdaInvoke(this, "Implement", {
      lambdaFunction: implementFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "kiroModel.$": "$.kiroModel",
        "executionMode.$": "$.approval.selectedMode",
        "approvedArtifact.$": "$.approval.selectedArtifact",
        "validation.$": "$.validation",
      }),
      payloadResponseOnly: true,
      resultPath: "$.implementResult",
    });

    const seedValidation = new sfn.Pass(this, "SeedValidation", {
      result: sfn.Result.fromObject({ issues: [] }),
      resultPath: "$.validation",
    });

    const validate = new tasks.LambdaInvoke(this, "Validate", {
      lambdaFunction: validateFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "executionMode.$": "$.approval.selectedMode",
        "approvedArtifact.$": "$.approval.selectedArtifact",
        "implementResult.$": "$.implementResult",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.validation",
    });

    const reportTask = (id: string, mode: string) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: reportFn,
        payload: sfn.TaskInput.fromObject({
          "runId.$": "$.runId",
          mode,
        }),
        payloadResponseOnly: true,
        resultPath: "$.report",
      });

    const reportSuccess = reportTask("ReportSuccess", "success");
    const reportNeedsHuman = reportTask("ReportNeedsHuman", "needsHuman");
    const reportCancelled = reportTask("ReportCancelled", "cancelled");

    const reportFailed = new tasks.LambdaInvoke(this, "ReportFailed", {
      lambdaFunction: reportFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        mode: "failed",
        "error.$": "$.error",
        "failureStage.$": "$.failure.failureStage",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.report",
    });

    const transientLambdaErrors = [
      "Lambda.ServiceException",
      "Lambda.AWSLambdaException",
      "Lambda.SdkClientException",
      "Lambda.TooManyRequestsException",
    ];
    for (const task of [triage, draft, validate]) {
      task.addRetry({
        errors: transientLambdaErrors,
        interval: cdk.Duration.seconds(2),
        backoffRate: 2,
        maxAttempts: 3,
      });
    }
    reportFailed.addRetry({
      errors: transientLambdaErrors,
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });

    const executionChoice = new sfn.Choice(this, "ExecuteOrCancel?")
      .when(
        sfn.Condition.or(
          sfn.Condition.stringEquals("$.approval.action", "execute"),
          sfn.Condition.booleanEquals("$.approval.approved", true)
        ),
        seedValidation.next(implement)
      )
      .otherwise(reportCancelled);

    const autoExecuteChoice = new sfn.Choice(this, "AutoExecuteSimple?")
      .when(
        sfn.Condition.and(
          sfn.Condition.booleanEquals("$.autoExecuteSimple", true),
          sfn.Condition.stringEquals("$.triage.complexity", "SIMPLE")
        ),
        autoDecision
      )
      .otherwise(awaitApproval);

    const securityStart = new tasks.LambdaInvoke(this, "SecurityStart", {
      lambdaFunction: securityStartFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "implementResult.$": "$.implementResult",
      }),
      payloadResponseOnly: true,
      resultPath: "$.securityStart",
    });
    securityStart.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });

    const securityWait = new sfn.Wait(this, "SecurityWait", {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const securityCheck = new tasks.LambdaInvoke(this, "SecurityCheck", {
      lambdaFunction: securityCheckFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "securityStart.$": "$.securityStart",
      }),
      payloadResponseOnly: true,
      resultPath: "$.securityStart",
    });
    securityCheck.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });

    const securityDone = new sfn.Choice(this, "SecurityDone?")
      .when(sfn.Condition.booleanEquals("$.securityStart.complete", true), reportSuccess)
      .otherwise(securityWait);

    // Async path: start security review but skip to report immediately
    const securityStartAsync = new tasks.LambdaInvoke(this, "SecurityStartAsync", {
      lambdaFunction: securityStartFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "implementResult.$": "$.implementResult",
      }),
      payloadResponseOnly: true,
      resultPath: "$.securityStart",
    });
    securityStartAsync.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });
    securityStartAsync.next(reportSuccess);

    // Route based on securityMode: skip | scan (async) | remediate (wait+loop)
    const securityModeChoice = new sfn.Choice(this, "SecurityRemediationEnabled?")
      .when(
        sfn.Condition.stringEquals("$.securityMode", "remediate"),
        securityStart
      )
      .when(
        sfn.Condition.stringEquals("$.securityMode", "scan"),
        securityStartAsync
      )
      .otherwise(reportSuccess); // skip

    // Wire: start → wait → check → done? → (loop or report)
    securityStart.next(securityWait);
    securityWait.next(securityCheck);
    securityCheck.next(securityDone);

    const validationChoice = new sfn.Choice(this, "ValidationGreen?")
      .when(sfn.Condition.booleanEquals("$.validation.pass", true), securityModeChoice)
      .when(
        sfn.Condition.and(
          sfn.Condition.booleanEquals("$.validation.pass", false),
          sfn.Condition.numberLessThan("$.validation.fixAttempts", MAX_FIX_LOOPS)
        ),
        implement
      )
      .otherwise(reportNeedsHuman);

    triage.next(draft);
    draft.next(autoExecuteChoice);
    autoDecision.next(executionChoice);
    awaitApproval.next(executionChoice);
    implement.next(validate);
    validate.next(validationChoice);

    // Preserve the failing stage before routing every unhandled error to reporting.
    for (const [task, stage] of [
      [triage, "TRIAGE"],
      [draft, "DRAFT"],
      [autoDecision, "AUTO_DECISION"],
      [awaitApproval, "APPROVAL"],
      [implement, "IMPLEMENT"],
      [validate, "VALIDATE"],
      [securityStart, "SECURITY_START"],
      [securityCheck, "SECURITY_CHECK"],
    ] as const) {
      const failureStage = new sfn.Pass(this, `${stage}FailureStage`, {
        result: sfn.Result.fromObject({ failureStage: stage }),
        resultPath: "$.failure",
      });
      failureStage.next(reportFailed);
      task.addCatch(failureStage, {
        errors: ["States.ALL"],
        resultPath: "$.error",
      });
    }

    const stateMachine = new sfn.StateMachine(this, "BugFixWorkflow", {
      definitionBody: sfn.DefinitionBody.fromChainable(triage),
      timeout: cdk.Duration.hours(25),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, "WorkflowLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
      },
    });

    // ------------------------------------------------------------------
    // Cognito
    // ------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const userPoolClient = userPool.addClient("WebClient", {
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
    });
    const resetterGroup = new cognito.CfnUserPoolGroup(this, "RepoResettersGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "repo-resetters",
      description: "Authenticated PoC users allowed to restore the canonical buggy main branch",
      precedence: 10,
    });

    // ------------------------------------------------------------------
    // API Lambdas + HTTP API with Cognito JWT authorizer
    // ------------------------------------------------------------------
    const apiFn = (name: string, entry: string, env: Record<string, string>) =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, "..", "lambdas", "api", entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(29),
        memorySize: 256,
        logRetention: logs.RetentionDays.ONE_WEEK,
        bundling: { externalModules: [], minify: true, sourceMap: false },
        environment: env,
      });

    const startRunFn = apiFn("StartRunFn", "start-run.ts", {
      RUNS_TABLE: runsTable.tableName,
      STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      CONTEXT_TABLE: contextTable.tableName,
    });
    startRunFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [contextTable.tableArn],
      })
    );
    const getRunsFn = apiFn("GetRunsFn", "get-runs.ts", {
      RUNS_TABLE: runsTable.tableName,
    });
    const decisionFn = apiFn("DecisionFn", "decision.ts", {
      RUNS_TABLE: runsTable.tableName,
    });
    const getModelsFn = apiFn("GetModelsFn", "get-models.ts", {
      AGENT_RUNTIME_ARN: agentRuntime.attrAgentRuntimeArn,
    });
    const repositoryReadFn = apiFn("RepositoryReadFn", "repository-read.ts", {
      REPO_NAME: repo.repositoryName,
      RUNS_TABLE: runsTable.tableName,
      BASE_BRANCH,
    });
    const repositoryResetFn = apiFn("RepositoryResetFn", "repository-reset.ts", {
      REPO_NAME: repo.repositoryName,
      RUNS_TABLE: runsTable.tableName,
      REPO_CONTROL_TABLE: repoControlTable.tableName,
      RESET_AUDIT_TABLE: resetAuditTable.tableName,
      BASE_BRANCH,
      RESETTER_GROUP: "repo-resetters",
    });
    const repositoryDeleteFn = apiFn("RepositoryDeleteFn", "repository-delete.ts", {
      REPO_NAME: repo.repositoryName,
      RUNS_TABLE: runsTable.tableName,
      REPO_CONTROL_TABLE: repoControlTable.tableName,
      RESET_AUDIT_TABLE: resetAuditTable.tableName,
      RESETTER_GROUP: "repo-resetters",
    });
    const contextApiFn = apiFn("ContextApiFn", "context.ts", {
      CONTEXT_TABLE: contextTable.tableName,
      CONTEXT_BUCKET: contextBucket.bucketName,
    });
    const mcpApiFn = apiFn("McpApiFn", "mcp.ts", {
      CONTEXT_TABLE: contextTable.tableName,
    });
    mcpApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [contextTable.tableArn],
      })
    );
    const contextCleanupFn = apiFn("ContextCleanupFn", "context-cleanup.ts", {
      CONTEXT_TABLE: contextTable.tableName,
      CONTEXT_BUCKET: contextBucket.bucketName,
    });

    runsTable.grantReadWriteData(startRunFn);
    runsTable.grantReadData(getRunsFn);
    runsTable.grantReadWriteData(decisionFn);
    stateMachine.grantStartExecution(startRunFn);
    stateMachine.grantTaskResponse(decisionFn);
    repo.grantRead(repositoryReadFn);
    repositoryReadFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codecommit:ListBranches"],
        resources: [repo.repositoryArn],
      })
    );
    runsTable.grantReadData(repositoryReadFn);
    runsTable.grantReadWriteData(repositoryResetFn);
    repoControlTable.grantReadWriteData(repositoryResetFn);
    resetAuditTable.grantReadWriteData(repositoryResetFn);
    repositoryResetFn.addEnvironment("STATE_MACHINE_ARN", stateMachine.stateMachineArn);
    repositoryResetFn.addEnvironment("AGENT_SPACE_ID", "as-6b6ad79c-b406-4765-aa20-7e8a904e6f9e");
    repositoryResetFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["states:ListExecutions", "states:StopExecution"],
        resources: [stateMachine.stateMachineArn, `${stateMachine.stateMachineArn}:*`,
          `arn:aws:states:${this.region}:${this.account}:execution:*`],
      })
    );
    repositoryResetFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["securityagent:*"],
        resources: ["*"],
      })
    );
    repositoryResetFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "codecommit:GetBranch",
          "codecommit:GetCommit",
          "codecommit:GetFolder",
          "codecommit:GetFile",
          "codecommit:CreateCommit",
        ],
        resources: [repo.repositoryArn],
      })
    );
    repositoryDeleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codecommit:GetBranch", "codecommit:DeleteBranch"],
        resources: [repo.repositoryArn],
      })
    );
    repositoryDeleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [runsTable.tableArn],
      })
    );
    repositoryDeleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [repoControlTable.tableArn],
      })
    );
    repositoryDeleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [resetAuditTable.tableArn],
      })
    );
    contextApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [contextTable.tableArn],
      })
    );
    contextApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [`${contextBucket.bucketArn}/users/*`],
      })
    );
    contextCleanupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:Scan",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [contextTable.tableArn],
      })
    );
    contextCleanupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:DeleteObject"],
        resources: [`${contextBucket.bucketArn}/users/*`],
      })
    );
    new events.Rule(this, "ContextCleanupSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(contextCleanupFn)],
    });
    getModelsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          agentRuntime.attrAgentRuntimeArn,
          `${agentRuntime.attrAgentRuntimeArn}/*`,
        ],
      })
    );

    const authorizer = new apigwv2Auth.HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] }
    );

    const httpApi = new apigwv2.HttpApi(this, "Api", {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        // PoC: CloudFront domain is unknown until deploy; tighten afterwards.
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: cdk.Duration.hours(1),
      },
    });
    httpApi.addRoutes({
      path: "/models",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Int.HttpLambdaIntegration("GetModelsInt", getModelsFn),
    });
    httpApi.addRoutes({
      path: "/mcp/config",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("McpConfigInt", mcpApiFn),
    });
    for (const [routePath, method, routeId] of [
      ["/context", apigwv2.HttpMethod.GET, "ContextListInt"],
      ["/context/notes", apigwv2.HttpMethod.POST, "ContextNotesInt"],
      ["/context/uploads", apigwv2.HttpMethod.POST, "ContextUploadsInt"],
      ["/context/{itemId}/complete", apigwv2.HttpMethod.POST, "ContextCompleteInt"],
      ["/context/{itemId}/preview", apigwv2.HttpMethod.GET, "ContextPreviewInt"],
      ["/context/{itemId}", apigwv2.HttpMethod.DELETE, "ContextDeleteInt"],
    ] as const) {
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: new apigwv2Int.HttpLambdaIntegration(routeId, contextApiFn),
      });
    }
    for (const [routePath, routeId] of [
      ["/repository/refs", "RepositoryRefsInt"],
      ["/repository/tree", "RepositoryTreeInt"],
      ["/repository/file", "RepositoryFileInt"],
      ["/runs/{runId}/review", "RunReviewInt"],
    ] as const) {
      httpApi.addRoutes({
        path: routePath,
        methods: [apigwv2.HttpMethod.GET],
        integration: new apigwv2Int.HttpLambdaIntegration(routeId, repositoryReadFn),
      });
    }
    httpApi.addRoutes({
      path: "/repository/reset-status",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Int.HttpLambdaIntegration(
        "RepositoryResetStatusInt",
        repositoryResetFn
      ),
    });
    httpApi.addRoutes({
      path: "/repository/reset",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration(
        "RepositoryResetInt",
        repositoryResetFn
      ),
    });
    httpApi.addRoutes({
      path: "/repository/fix-branches/{runId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new apigwv2Int.HttpLambdaIntegration(
        "RepositoryDeleteFixBranchInt",
        repositoryDeleteFn
      ),
    });
    httpApi.addRoutes({
      path: "/runs",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("StartRunInt", startRunFn),
    });
    httpApi.addRoutes({
      path: "/runs",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Int.HttpLambdaIntegration("ListRunsInt", getRunsFn),
    });
    httpApi.addRoutes({
      path: "/runs/{runId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Int.HttpLambdaIntegration("GetRunInt", getRunsFn),
    });
    httpApi.addRoutes({
      path: "/runs/{runId}/decision",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("DecisionInt", decisionFn),
    });

    // ------------------------------------------------------------------
    // UI hosting: private S3 + CloudFront (OAC)
    // ------------------------------------------------------------------
    const uiBucket = new s3.Bucket(this, "UiBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, "UiDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        // SPA routing
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    new s3deploy.BucketDeployment(this, "UiDeployment", {
      destinationBucket: uiBucket,
      distribution,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "..", "..", "ui", "dist")),
        s3deploy.Source.jsonData("config.json", {
          apiUrl: httpApi.apiEndpoint,
          region: this.region,
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
        }),
      ],
    });

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, "UiUrl", { value: `https://${distribution.domainName}` });

    // Wire Security Review Lambda to the CloudFront endpoint
    securityStartFn.addEnvironment("APP_ENDPOINT", `https://${distribution.domainName}`);
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "RepoCloneUrlHttp", { value: repo.repositoryCloneUrlHttp });
    new cdk.CfnOutput(this, "AgentRuntimeArn", { value: agentRuntime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, "StateMachineArn", { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, "KiroKeySecretArn", { value: kiroKeySecret.secretArn });
  }
}

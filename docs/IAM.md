# IAM Setup Guide

Transflow requires two IAM roles with specific permissions:

1. **Deploy Role** - Used by GitHub Actions to deploy infrastructure
2. **Execution Role** - Used by Lambda functions at runtime

## Quick Setup

### 1. Deploy Role (GitHub Actions)

Create a role for GitHub Actions OIDC authentication:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:*"
        }
      }
    }
  ]
}
```

### 2. Execution Role (Lambda Runtime)

Create a role for Lambda function execution:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

## Deploy Role Permissions

The deploy role needs permissions to create and manage AWS resources.

### ECR Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:TagResource"
      ],
      "Resource": "*"
    }
  ]
}
```

### Lambda Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction",
        "lambda:DeleteFunction",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:TagResource",
        "lambda:UntagResource"
      ],
      "Resource": "arn:aws:lambda:*:*:function:transflow-worker-*"
    }
  ]
}
```

### S3 Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketNotification",
        "s3:PutBucketNotification",
        "s3:GetBucketTagging",
        "s3:PutBucketTagging",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::*transflow*",
        "arn:aws:s3:::YOUR_PROJECT_NAME-*"
      ]
    }
  ]
}
```

### IAM Pass Role Permission

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/transflow-lambda-*",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "lambda.amazonaws.com"
        }
      }
    }
  ]
}
```

### CloudWatch Logs Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DescribeLogGroups",
        "logs:TagResource"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/aws/lambda/transflow-worker-*"
    }
  ]
}
```

### STS Permissions (Account Info)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity"],
      "Resource": "*"
    }
  ]
}
```

## Execution Role Permissions

The Lambda execution role needs permissions to access S3, publish to Redis, and write logs.

### Basic Lambda Execution

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
```

### S3 Access (Prefix Mode)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:HeadObject"],
      "Resource": ["arn:aws:s3:::YOUR_UPLOAD_BUCKET/uploads/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl"],
      "Resource": ["arn:aws:s3:::YOUR_OUTPUT_BUCKET/outputs/*"]
    }
  ]
}
```

### S3 Access (Bucket Mode)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:HeadObject",
        "s3:PutObject",
        "s3:PutObjectAcl"
      ],
      "Resource": ["arn:aws:s3:::YOUR_PROJECT_NAME-*/*"]
    }
  ]
}
```

### DynamoDB Access (Required)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:*:*:table/YOUR_TABLE_NAME"
    }
  ]
}
```

## Complete Policy Examples

### Deploy Role Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRPermissions",
      "Effect": "Allow",
      "Action": ["ecr:*"],
      "Resource": "*"
    },
    {
      "Sid": "LambdaPermissions",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction",
        "lambda:DeleteFunction",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:TagResource",
        "lambda:UntagResource"
      ],
      "Resource": "arn:aws:lambda:*:*:function:transflow-worker-*"
    },
    {
      "Sid": "S3Permissions",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketNotification",
        "s3:PutBucketNotification",
        "s3:GetBucketTagging",
        "s3:PutBucketTagging",
        "s3:ListBucket"
      ],
      "Resource": ["arn:aws:s3:::*transflow*", "arn:aws:s3:::myapp-*"]
    },
    {
      "Sid": "IAMPassRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/transflow-lambda-*",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "lambda.amazonaws.com"
        }
      }
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DescribeLogGroups",
        "logs:TagResource"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/aws/lambda/transflow-worker-*"
    },
    {
      "Sid": "STSPermissions",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
```

### Execution Role Policy (Prefix Mode)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LambdaBasic",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Sid": "S3InputAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::myapp-uploads/uploads/*"
    },
    {
      "Sid": "S3OutputAccess",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl"],
      "Resource": "arn:aws:s3:::myapp-outputs/outputs/*"
    },
    {
      "Sid": "DynamoDBAccess",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:*:*:table/YOUR_TABLE_NAME"
    }
  ]
}
```

## AWS CLI Setup Commands

### 1. Create OIDC Provider (One-time setup)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
  --client-id-list sts.amazonaws.com
```

### 2. Create Deploy Role

```bash
# Create trust policy
cat > trust-policy-deploy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:*"
        }
      }
    }
  ]
}
EOF

# Create role
aws iam create-role \
  --role-name transflow-deploy-role \
  --assume-role-policy-document file://trust-policy-deploy.json \
  --description "Transflow GitHub Actions deploy role"

# Attach policies (create custom policies first)
aws iam attach-role-policy \
  --role-name transflow-deploy-role \
  --policy-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/TransflowDeployPolicy
```

### 3. Create Execution Role

```bash
# Create trust policy
cat > trust-policy-execution.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role
aws iam create-role \
  --role-name transflow-lambda-role \
  --assume-role-policy-document file://trust-policy-execution.json \
  --description "Transflow Lambda execution role"

# Attach AWS managed policy
aws iam attach-role-policy \
  --role-name transflow-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Attach custom policy
aws iam attach-role-policy \
  --role-name transflow-lambda-role \
  --policy-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/TransflowExecutionPolicy
```

## Security Best Practices

### Least Privilege Access

- Scope S3 permissions to specific prefixes/buckets
- Limit Lambda function name patterns
- Use condition keys for additional restrictions

### Resource Constraints

```json
{
  "Condition": {
    "StringLike": {
      "lambda:FunctionName": "transflow-worker-*"
    },
    "NumericLessThan": {
      "lambda:MemorySize": "10240"
    }
  }
}
```

### Cross-Account Access

For multi-account deployments:

```json
{
  "Condition": {
    "StringEquals": {
      "aws:RequestedRegion": ["us-east-1", "eu-west-1"]
    },
    "StringLike": {
      "aws:PrincipalArn": "arn:aws:iam::DEPLOY_ACCOUNT:role/transflow-deploy-role"
    }
  }
}
```

### Time-based Restrictions

```json
{
  "Condition": {
    "DateGreaterThan": {
      "aws:CurrentTime": "2024-01-01T00:00:00Z"
    },
    "DateLessThan": {
      "aws:CurrentTime": "2024-12-31T23:59:59Z"
    }
  }
}
```

## Validation Commands

Verify IAM setup:

```bash
# Test deploy role assumption
aws sts assume-role \
  --role-arn arn:aws:iam::ACCOUNT:role/transflow-deploy-role \
  --role-session-name test-session

# Test ECR access
aws ecr describe-repositories --repository-names transflow-worker

# Test S3 bucket creation
aws s3 mb s3://test-transflow-bucket --region us-east-1

# Test Lambda function creation (dry run)
aws lambda create-function \
  --function-name test-transflow-function \
  --runtime provided.al2 \
  --role arn:aws:iam::ACCOUNT:role/transflow-lambda-role \
  --handler index.handler \
  --zip-file fileb://test.zip \
  --dry-run
```

## Common Issues

### Permission Denied Errors

- Verify role ARNs in configuration
- Check trust relationships
- Ensure OIDC provider is configured correctly

### S3 Access Issues

- Confirm bucket names match configuration
- Verify prefix permissions for branch isolation
- Check bucket region vs Lambda region

### Lambda Function Issues

- Ensure execution role has basic Lambda permissions
- Verify memory and timeout limits in IAM policies
- Check CloudWatch Logs permissions

This IAM guide provides the foundation for secure Transflow deployments. Adjust policies based on your specific security requirements and organizational standards.

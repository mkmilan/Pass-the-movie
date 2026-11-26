#!/usr/bin/env bash
# Run in AWS CloudShell as the account owner or an authorized IAM administrator.
# Only this project branch can assume the role, and it can only read Device Farm settings.
set -euo pipefail
export AWS_PAGER=""
region=us-west-2
stack=PassTheMovieDeviceFarmReadOnly
issuer=token.actions.githubusercontent.com
account=$(aws sts get-caller-identity --query Account --output text)
provider="arn:aws:iam::${account}:oidc-provider/${issuer}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Retain the original provider ownership choice on repeated runs.
if aws cloudformation describe-stacks --region "$region" --stack-name "$stack" > "$tmp/stack" 2>"$tmp/error"; then
  create=$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1]))["Stacks"][0]["Parameters"]; print(next(x["ParameterValue"] for x in p if x["ParameterKey"]=="CreateProvider"))' "$tmp/stack")
elif grep -qi 'does not exist' "$tmp/error"; then
  providers=$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output json)
  create=$(python3 -c 'import json,sys;print("no" if sys.argv[1] in json.load(sys.stdin) else "yes")' "$provider" <<< "$providers")
else
  cat "$tmp/error" >&2
  exit 1
fi
if [[ "$create" == no ]]; then
  audiences=$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider" --query ClientIDList --output json)
  python3 -c 'import json,sys; sys.exit(0 if "sts.amazonaws.com" in json.load(sys.stdin) else "The existing GitHub identity provider needs the sts.amazonaws.com audience.")' <<< "$audiences"
fi

cat > "$tmp/role.yaml" <<'CFN'
AWSTemplateFormatVersion: '2010-09-09'
Description: Read-only Device Farm connection for the Pass the Movie test repository.
Parameters:
  CreateProvider:
    Type: String
    AllowedValues: ['yes', 'no']
Conditions:
  NewProvider: !Equals [!Ref CreateProvider, 'yes']
Resources:
  GitHubProvider:
    Type: AWS::IAM::OIDCProvider
    Condition: NewProvider
    Properties:
      Url: https://token.actions.githubusercontent.com
      ClientIdList: [sts.amazonaws.com]
  DeviceFarmReader:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Federated: !If [NewProvider, !Ref GitHubProvider, !Sub 'arn:${AWS::Partition}:iam::${AWS::AccountId}:oidc-provider/token.actions.githubusercontent.com']
            Action: sts:AssumeRoleWithWebIdentity
            Condition:
              StringEquals:
                'token.actions.githubusercontent.com:aud': sts.amazonaws.com
                'token.actions.githubusercontent.com:sub': 'repo:mkmilan@13180642/Pass-the-movie@1470033537:ref:refs/heads/test/aws-devicefarm-access'
      Policies:
        - PolicyName: ReadDeviceFarmSettings
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: devicefarm:GetAccountSettings
                Resource: '*'
                Condition:
                  StringEquals:
                    'aws:RequestedRegion': us-west-2
Outputs:
  DeviceFarmRoleArn:
    Value: !GetAtt DeviceFarmReader.Arn
CFN

aws cloudformation deploy --region "$region" --stack-name "$stack" \
  --template-file "$tmp/role.yaml" --parameter-overrides "CreateProvider=$create" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
role=$(aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
  --query "Stacks[0].Outputs[?OutputKey=='DeviceFarmRoleArn'].OutputValue | [0]" --output text)

echo 'Save this value in the Pass-the-movie GitHub Actions secret AWS_DEVICEFARM_ROLE_ARN:'
echo "$role"
echo 'Remaining free Device Farm minutes (visible only in this AWS shell):'
aws devicefarm get-account-settings --region "$region" --query 'accountSettings.trialMinutes.remaining' --output text

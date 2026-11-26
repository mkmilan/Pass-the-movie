# Connect Pass the Movie to AWS Device Farm

This gives one test branch permission to read Device Farm account settings, including free trial minutes. Starting phone sessions requires a separate permission. Your AWS password and access keys stay private.

1. Sign in to your AWS console and open **CloudShell** using the terminal icon in the top bar. Paste this command and press Enter. It downloads the pinned setup script from your repository, creates the read-only role, and prints its ARN (the role identifier) and your remaining trial minutes.

   ```bash
   curl -fsSLo ptm-devicefarm-connect.sh https://raw.githubusercontent.com/mkmilan/Pass-the-movie/20acf4ab944a4aa3918eda0bc843b399b880c633/qa/aws-devicefarm/connect.sh && bash ptm-devicefarm-connect.sh
   ```

   [Review the setup script](https://github.com/mkmilan/Pass-the-movie/blob/20acf4ab944a4aa3918eda0bc843b399b880c633/qa/aws-devicefarm/connect.sh) · [AWS CloudShell instructions](https://docs.aws.amazon.com/awsconsolehelpdocs/latest/gsg/launch-cloudshell.html)

2. Copy the output line beginning with `arn:aws:iam::`. In [New repository secret](https://github.com/mkmilan/Pass-the-movie/settings/secrets/actions/new), enter **AWS_DEVICEFARM_ROLE_ARN** as the name, paste that line as the value, and tap **Add secret**.

Return to the chat and say **ready**. The connection check reads Device Farm settings in Oregon. Its public log reports whether access worked. Your account number and minute balance stay out of the log.

The setup requires permission to create a CloudFormation stack and IAM role. It reuses a compatible GitHub identity provider if one exists, otherwise it creates one. To revoke access, delete the **PassTheMovieDeviceFarmReadOnly** stack in Oregon and remove the GitHub secret. If you later reuse the stack’s identity provider for other projects, retain that provider when deleting the stack.

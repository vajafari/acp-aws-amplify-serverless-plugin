'use strict';
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const stringify = require('json-stable-stringify-pretty');

class ServerlessPlugin {

  constructor(serverless, options) {
      this.serverless = serverless;
      this.options = options;

      this.provider = this.serverless.getProvider('aws');
      this.stage = this.provider.getStage();
      this.config = this.serverless.service.custom.amplify || [];

      this.hooks = {
          'after:deploy:deploy': this.process.bind(this)
      };
  }
  

  log(level, message) {
    if (level == 'error') {
        console.log(chalk.red(`ERROR: amplify-plugin: ${message}`));
    } else if (level == 'warn') {
        console.log(chalk.yellow(`WARNING: amplify-plugin: ${message}`));
    } else if (level == 'info') {
        if (this.options.v) console.log(chalk.green('amplify-plugin: ') + message);
    } else {
        if (process.env.SLS_DEBUG) console.log(chalk.blue('amplify-plugin: ') + message);
    }
  }

  stackName() {
    return this.provider.naming.getStackName();
  }

  async fetch(apiName, operation, parameters) {
    this.log('debug', `fetch(${apiName}, ${operation}, ${JSON.stringify(parameters)})`);
    return this.provider.request(apiName, operation, parameters);
  }

  async listStackResources(stackName) {
      let resources = [];
      let request = { StackName: stackName };
      let morePages = false;

      do {
          let result = await this.fetch('CloudFormation', 'listStackResources', request);
          result.StackResourceSummaries.forEach(item => { resources.push(item); });
          request.NextToken = result.NextToken;
          morePages = result.NextToken ? true : false;
      } while (morePages);
      
      for (let resource of resources) {
          if (resource.ResourceType === 'AWS::CloudFormation::Stack') {
              const nestedStackName = resource.PhysicalResourceId.split('/')[1];
              this.log('info', `Processing nested stack: ${nestedStackName}`);
              const nestedResources = await this.listStackResources(nestedStackName);
              resources.push(...nestedResources);
          }
      }

      return resources;
  }

  async describeStackResources(resources) {
    let detailedResources = [];
    for (let i = 0 ; i < resources.length ; i++) {
        const resource = resources[i];
        switch (resource.ResourceType) {
            case 'AWS::AppSync::GraphQLApi':
                this.log('debug', `Processing ${JSON.stringify(resource)}`);
                const appSyncId = resource.PhysicalResourceId.split('/')[1];
                let appSyncMetaData = await this.fetch('AppSync', 'getGraphqlApi', { apiId: appSyncId });
                let appSyncSchema = await this.fetch('AppSync', 'getIntrospectionSchema', { apiId: appSyncId, format: 'JSON' });
                detailedResources.push(Object.assign({}, resource, { metadata: appSyncMetaData, schema:  JSON.parse(appSyncSchema.schema.toString()) }));
                break;
            case 'AWS::Cognito::IdentityPool':
                this.log('debug', `Processing ${JSON.stringify(resource)}`);
                let idpMetadata = await this.fetch('CognitoIdentity', 'describeIdentityPool', { IdentityPoolId: resource.PhysicalResourceId });
                detailedResources.push(Object.assign({}, resource, { metadata: idpMetadata }));
                break;
            case 'AWS::Cognito::UserPool':
                this.log('debug', `Processing ${JSON.stringify(resource)}`);
                const userPoolMetaData = await this.fetch('CognitoIdentityServiceProvider', 'describeUserPool', { UserPoolId: resource.PhysicalResourceId });
                detailedResources.push(Object.assign({}, resource, { metadata: userPoolMetaData }));
                break;
            case 'AWS::S3::Bucket':
                this.log('debug', `Processing ${JSON.stringify(resource)}`);
                detailedResources.push(resource);   // We have all the details we need for this
                break;
            case 'AWS::ApiGateway::RestApi':
                this.log('debug', `Processing ${JSON.stringify(resource)}`);
                detailedResources.push(resource);
                break;
            default:
                this.log('debug', `Skipping ${JSON.stringify(resource)}`);
                break;
        }
    }

    // Process User pool clients AFTER the user pool
    for (let i = 0 ; i < resources.length ; i++) {
        const resource = resources[i];
        switch (resource.ResourceType) {
            case 'AWS::Cognito::UserPoolClient':
                this.log('debug', `Processing ${JSON.stringify(resource)}`);
                const cfTemplate =  this.serverless.service.provider.compiledCloudFormationTemplate.Resources[resource.LogicalResourceId];
                const userPoolName = cfTemplate.Properties.UserPoolId.Ref;
                const userPoolResource = resources.filter(r => r.ResourceType === 'AWS::Cognito::UserPool' && r.LogicalResourceId === userPoolName)[0];
                let result = await this.fetch('CognitoIdentityServiceProvider', 'describeUserPoolClient', {
                    ClientId: resource.PhysicalResourceId,
                    UserPoolId: userPoolResource.PhysicalResourceId
                });
                detailedResources.push(Object.assign({}, resource, { metadata: result }));
                break;
        }
    }

    return detailedResources;
  }

  getJavaScriptConfiguration(resources) {
    let config = {};
    config.aws_project_region = this.provider.getRegion();

    if (fileDetails.hasOwnProperty('appClient')) {
        const appClient = resources.find(r => r.ResourceType === 'AWS::Cognito::UserPoolClient' && r.LogicalResourceId === fileDetails.appClient);
        if (typeof appClient !== 'undefined') {
            config.aws_cognito_region = appClient.metadata.UserPoolClient.UserPoolId.split('_')[0];
            config.aws_user_pools_id = appClient.metadata.UserPoolClient.UserPoolId;
            config.aws_user_pools_web_client_id = appClient.metadata.UserPoolClient.ClientId;

            if (appClient.metadata.UserPoolClient.hasOwnProperty('ClientSecret')) {
                config.aws_user_pools_web_client_secret = appClient.metadata.UserPoolClient.ClientSecret;
            }
        } else {
            throw new Error(`Invalid appClient specified: ${fileDetails.appClient}`);
        }
    }
    
    const identityPools = resources.filter(r => r.ResourceType === 'AWS::Cognito::IdentityPool');
    const identityPoolForUserPool = undefined;
    const identityPool = identityPoolForUserPool || identityPools[0];
    if (typeof identityPool !== 'undefined') {
        if (!config.hasOwnProperty("aws_cognito_region")) {
            config.aws_cognito_region = identityPool.PhysicalResourceId.split(':')[0];
        }
        config.aws_cognito_identity_pool_id = identityPool.PhysicalResourceId;

        if (typeof identityPool.metadata.SupportedLoginProviders == 'object') {
            const providers = identityPool.metadata.SupportedLoginProviders;
            const federated = {};
            let hasFederated = false;

            // Each authentication provider that is supported for federation  has an entry in
            // the SupportedLoginProviders that is a "magic" domain - constant for each provider.
            // Once you know the provider domain, you can easily add new provider support.
            if ('accounts.google.com' in providers) {
                federated.google_client_id = providers['accounts.google.com'];
                hasFederated = true;
            }

            if ('graph.facebook.com' in providers) {
                federated.facebook_app_id = providers['graph.facebook.com'];
                hasFederated = true;
            }

            if ('www.amazon.com' in providers) {
                federated.amazon_client_id = providers['www.amazon.com'];
                hasFederated = true;
            }

            if (hasFederated) {
                config.federated = federated;
            }
        }
    }

    const appSync = resources.find(r => r.ResourceType === 'AWS::AppSync::GraphQLApi');
    if (typeof appSync !== 'undefined') {
        config.aws_appsync_graphqlEndpoint = appSync.metadata.graphqlApi.uris.GRAPHQL;
        config.aws_appsync_region = appSync.metadata.graphqlApi.arn.split(':')[3];
        config.aws_appsync_authenticationType = appSync.metadata.graphqlApi.authenticationType;
    }

    let s3buckets = resources.filter(r => r.ResourceType === 'AWS::S3::Bucket' && r.LogicalResourceId !== 'ServerlessDeploymentBucket');
    if (s3buckets.length > 0) {
        let userFiles = s3buckets[0];
        if (typeof userFiles !== 'undefined') {
            config.aws_user_files_s3_bucket = userFiles.PhysicalResourceId;
            config.aws_user_files_s3_bucket_region = this.provider.getRegion();
        }
    }

    let apigw = resources.filter(r => r.ResourceType === 'AWS::ApiGateway::RestApi');
    if (apigw.length > 0) {
        let apiRecords = [];
        apigw.forEach((v) => {
            apiRecords.push({
                endpoint: `https://${v.PhysicalResourceId}.execute-api.${this.provider.getRegion()}.amazonaws.com/${this.provider.getStage()}`,
                name: v.LogicalResourceId,
                region: this.provider.getRegion()
            });
        });
        config.aws_cloud_logic_custom = apiRecords;
    }

    return config;
  }

  writeTypeScriptConfiguration(resources) {
    let config = this.getJavaScriptConfiguration(resources);
    let config_header = [
        '// WARNING: DO NOT EDIT.  This file is automatically generated',
        `// Written by ${this.useragent} on ${new Date().toISOString()}`,
        '',
        'interface IAWSAmplifyFederatedConfiguration {',
        '    google_client_id?: string;',
        '    facebook_app_id?: string;',
        '    amazon_client_id?: string;',
        '}',
        '',
        'interface IAWSAmplifyCloudLogicConfiguration {',
        '    [index: number]: {',
        '        endpoint: string;',
        '        name: string;',
        '        region: string;',
        '    };',
        '}',
        '',
        'interface IAWSAmplifyConfiguration {',
        '    aws_appsync_authenticationType?: string;',
        '    aws_appsync_graphqlEndpoint?: string;',
        '    aws_appsync_region?: string;',
        '    aws_cognito_identity_pool_id?: string;',
        '    aws_cognito_region?: string;',
        '    aws_cloud_logic_custom?: IAWSAmplifyCloudLogicConfiguration;',
        '    aws_project_region: string;',
        '    aws_user_files_s3_bucket?: string;',
        '    aws_user_files_s3_bucket_region?: string;',
        '    aws_user_pools_id?: string;',
        '    aws_user_pools_web_client_id?: string;',
        '    aws_user_pools_web_client_secret?: string;',
        '    federated?: IAWSAmplifyFederatedConfiguration;',
        '}',
        ''
    ].join("\n");
    let config_body = `const awsmobile: IAWSAmplifyConfiguration = ${stringify(config, { pretty: true, space: 4 })};`;
    let config_footer = "\nexport default awsmobile;\n"
    this.writeConfigurationFile("aws-exports.ts", [config_header, config_body, config_footer].join('\n'));
  }

  writeConfigurationFile(filename, contents) {
    fs.writeFile(filename, contents, 'utf8', (err, data) => {
        if (err) {
            this.log('error', `Writing to ${filename}: ${err}`);
        }
    });
  }
  
  process() {
    this.log('info', `Processing stack: ${this.stackName()}`);
    const resources = this.listStackResources(this.stackName())
        .then(resources => this.describeStackResources(resources))
        .then(resources => this.writeTypeScriptConfiguration(resources))
        .catch(error => this.log('error', `Cannot load resources: ${error.message}`));
    return resources;
  }

}

module.exports = ServerlessPlugin;

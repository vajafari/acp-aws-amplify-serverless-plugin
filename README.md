# ACP AWS Amplify Plugin for Serverless Framework

This is a plugin for the [Serverless Framework](https://serverless.com) that generates appropriate configuration files for using [AWS Amplify](https://aws-amplify.github.io) with the Serverless Framework.

This project is forked from [aws-amplify-serverless-plugin]( https://github.com/amazon-archives/aws-amplify-serverless-plugin) 


## Installation

Install the plugin via Yarn (recommended)

```
yarn add acp-aws-amplify-serverless-plugin
```

or via NPM

```
npm install --save acp-aws-amplify-serverless-plugin
```

## Configuration

Edit your `serverless.yml` file to include something like the following:

```
plugins:
  - acp-aws-amplify-serverless-plugin

```
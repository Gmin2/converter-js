import type { AsyncAPIDocument, ConvertOptions, ConvertV2ToV3Options, ConvertFunction } from './interfaces';
import { isPlainObject, createRefObject, isRefObject, sortObjectKeys, getValueByRef, getValueByPath, createRefPath, isRemoteRef } from './utils';
import openapi from './openapi.json'
// import { convertInfoObject } from 'third-version';

// console.log(convertServerObjects(openapi.servers,openapi))


export function openAPI_to_asyncAPI( openAPI: any) {
    
}

/** Tags and externalDocs to info objects */

function convertInfoObject(openAPI: any) {
  if (openAPI.tags) {
    openAPI.info.tags = openAPI.tags;
    delete openAPI.tags;
  }

  if(openAPI.externalDocs) {
    openAPI.info.externalDocs = openAPI.externalDocs;
    delete openAPI.externalDocs;
  }

  return (openAPI.info = sortObjectKeys(openAPI.info, [
    "title",
    "version",
    "description",
    "termsOfService",
    "contact",
    "license",
    "tags",
    "externalDocs",
  ]));
}

/**
  * split url to protocol :// url :// protocolVersion
 */

function convertServerObjects(servers: Record<string, any>, openAPI: any) {
  console.log("security",openAPI.security)
  const newServers: Record<string, any> = {};
  const security: Record<string, any> = openAPI.security;
  Object.entries(servers).forEach(([serverName, server]: [string, any]) => {
    if (isRefObject(server)) {
      newServers[serverName] = server;
      return;
    }

    const {host, pathname, protocol } = resolveServerUrl(server.url);
    server.host = host;
    if (pathname !== undefined) {
      server.pathname = pathname;
    }
    // Dont overwrite anything
    if(protocol !== undefined && server.protocol === undefined) {
      server.protocol = protocol;
    }
    delete server.url;

    // console.log("server.security",openAPI.security)
    if (security) {
      server.security = security;
      delete openAPI.security;
    }

    newServers[serverName] = sortObjectKeys(
      server,
      ['host', 'pathname', 'protocol', 'protocolVersion', 'title', 'summary', 'description', 'variables', 'security', 'tags', 'externalDocs', 'bindings'],
    );
  });
  return JSON.stringify(newServers);
}

function resolveServerUrl(url: string): { host: string, pathname: string | undefined, protocol: string | undefined } {
  let [maybeProtocol, maybeHost] = url.split('://');
  console.log("maybeProtocol",maybeProtocol)

  if (!maybeHost) {
    maybeHost = maybeProtocol;
  }

  const [host, ...pathnames] = maybeHost.split('/');
  console.log("pathname1",pathnames)

  if (pathnames.length) {
    return { host, pathname: `/${pathnames.join('/')}`, protocol: maybeProtocol };
  }
  return { host, pathname: undefined, protocol: maybeProtocol };
}

function convertSecurity(security: Record<string, any>) {
  if(security.type === 'oauth2' && security.flows.authorizationCode.scopes) {
    const availableScopes = security.flows.authorizationCode.scopes;
    security.flows.authorizationCode.availableScopes = availableScopes;
    delete security.flows.authorizationCode.scopes;
  }
  return security;
}

type ConvertPathToChannelData = {
  asyncapi: AsyncAPIDocument;
  pathItem: any;
  path: string;
  options: any;
};

/**
 * Convert a single path item in OpenAPI to a channel in AsyncAPI.
 */
function convertPathToChannel(data: ConvertPathToChannelData) {
  const { asyncapi, pathItem, path, options } = data;
  const channel: any = {
    description: pathItem.description,
    parameters: convertParameters(pathItem.parameters),
  };

  const operations: Record<string, any> = convertPathToOperations(data);

  // Assign operations to the channel
  if (Object.keys(operations).length > 0) {
    if (options.pointOfView === 'application') {
      channel.receive = operations.get;
      channel.send = { ...operations.post, ...operations.put, ...operations.delete };
    } else {
      channel.send = operations.get;
      channel.receive = { ...operations.post, ...operations.put, ...operations.delete };
    }
  }

  return channel;
}

function convertParameters(parameters: Record<string, any>): Record<string, any> {
  const newParameters: Record<string, any> = {};
  Object.entries(parameters).forEach(([name, parameter]) => {
    newParameters[name] = convertParameter(parameter);
  });
  return newParameters;
}

function convertParameter(parameter: any): any {
  const ref = parameter['$ref'] ?? null;
  if(ref !== null) {
    return {
      $ref: ref
    }
  }

  if(parameter.schema?.$ref) {
    console.warn('Could not convert parameter object because the `.schema` property was a reference.\nThis have to be changed manually if you want any of the properties included. For now your parameter is an empty object after conversion. The reference was ' + parameter.schema?.$ref);
  }

  const enumValues = parameter.schema?.enum ?? null;
  const constValue = parameter.schema?.const ?? null;
  const defaultValues = parameter.schema?.default ?? null;
  const description = parameter.description ?? parameter.schema?.description ?? null;
  const examples = parameter.schema?.examples ?? null;
  const location = parameter.location ?? null;
  
  // reportUnsupportedParameterValues(parameter.schema);

  //Make sure we keep parameter extensions
  const v2ParameterObjectProperties = ["location", "schema", "description"];
  const v2ParameterObjectExtensions = Object.entries(parameter).filter(([key,]) => {
    return !v2ParameterObjectProperties.includes(key);
  });

  //Return the new v3 parameter object
  return {...v2ParameterObjectExtensions,
    ...(enumValues === null ? null : {enum: enumValues}),
    ...(constValue === null ? null : {enum: [constValue]}),
    ...(defaultValues === null ? null : {default: defaultValues}),
    ...(description === null ? null : {description}),
    ...(examples === null ? null : {examples}),
    ...(location === null ? null : {location})
  };
}



type ConvertPathToOperationsData = {
  asyncapi: AsyncAPIDocument;
  pathItem: any;
  path: string;
  options: any;
  context: any;
};

/**
 * Convert HTTP operations in OpenAPI to operations in AsyncAPI.
 */
function convertPathToOperations(data: ConvertPathToOperationsData) {
  const { asyncapi, pathItem, path, options, context } = data;
  const operations: Record<string, any> = {};

  // Convert HTTP operations to AsyncAPI operations
  Object.entries(pathItem).forEach(([operationName, operation]) => {
    if (operationName === 'parameters' || operationName === 'description') {
      return;
    }

    const operationData = {
      asyncapi,
      operation,
      path,
      operationName,
      options,
      context,
    };

    operations[operationName] = convertOperation(operationData);
  });

  return operations;
}


type ConvertOperationData = {
  asyncapi: AsyncAPIDocument;
  operation: any;
  path: string;
  operationName: string;
  options: any;
  context: any;
};

/**
 * Convert a single HTTP operation in OpenAPI to an operation in AsyncAPI.
 */

function convertOperation(data: ConvertOperationData) {
  const { asyncapi, operation, path, operationName, options, context } = data;
  const asyncapiOperation: any = {
    summary: operation.summary,
    description: operation.description,
    operationId: operation.operationId,
    tags: operation.tags,
  };

  // Convert request parameters to message
  if (operation.parameters) {
    const message = convertRequestParameters(operation.parameters, context);
    asyncapiOperation.message = message;
  }

  // Convert response schemas to messages
  if (isPlainObject(operation.responses)) {
    const messages = convertResponseSchemas(operation.responses, context);
    asyncapiOperation.messages = messages;
  }

  // Set the action based on the point of view
  if (options.pointOfView === 'application') {
    asyncapiOperation.action = operationName === 'get' ? 'receive' : 'send';
  } else {
    asyncapiOperation.action = operationName === 'get' ? 'send' : 'receive';
  }

  return asyncapiOperation;
}

// Helper functions for converting parameters and schemas to messages
function convertRequestParameters(parameters: any[], context: any) {
  // ...
}

function convertResponseSchemas(responses: Record<string, any>, context: any) {
  // ...
}

/**
 * Convert a single path item in OpenAPI to a channel and operations in AsyncAPI.
 */
function convertPath(data: ConvertPathToChannelData & { context: any }) {
  const { asyncapi, pathItem, path, options, context } = data;
  const channel = convertPathToChannel({ asyncapi, pathItem, path, options });
  const operations = convertPathToOperations({ asyncapi, pathItem, path, options, context });

  return { channel, operations };
}


// console.log(convertSecurity(openapi.security))

// console.log(openapi.security.flows.authorizationCode)

// console.log(resolveServerUrl("https://{username}.gigantic-server.com:{port}/{basePath}"))
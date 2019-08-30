# AsyncAPI Converter

Convert [AsyncAPI](https://asyncapi.com) documents from version 1.x to version 2.0.0.

## Installation

```sh
npm i -g asyncapi-converter
```

## Usage

### From CLI

Minimal example:

```sh
asyncapi-converter streetlights.yml

# Result:
asyncapi: '2.0.0'
channels:
...
```

Specify the application id:

```sh
asyncapi-converter --id=urn:com.asynapi.streetlights streetlights.yml

# Result:
asyncapi: '2.0.0'
id: 'urn:com.asynapi.streetlights'
...
```

Save the result in a file:

```sh
asyncapi-converter streetlights.yml > streetlights2.yml
```

### As a package

```js
const { convert } = require('asyncapi-converter')

try {
  const asyncapi = fs.readFileSync('streetlights.yml', 'utf-8')
  console.log(convert(asyncapi, '2.0.0', {
      id: 'urn:com.asynapi.streetlights'
  }))
} catch (e) {
  console.error(e)
}
```

## Known missing features

* Streaming APIs (those using `stream` instead of `topics` or `events`) are converted correctly but information about framing type and delimiter is missing until a [protocolInfo](https://github.com/asyncapi/extensions-catalog/issues/1) for that purpose is created.

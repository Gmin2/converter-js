/*
  It is a helper required for testing on windows. It can't be solved by editor configuration and the end line setting because expected result is converted during tests.
  We need to remove all line breaks from the string
  as well as all multiple spaces and trim the string.
*/
export function removeLineBreaks(str: string) {
  return str.replace(/\r?\n|\r/g, '').replace(/\s+/g, ' ').trim();
}

export function assertResults(output: string, result: string){
  try{
    expect(removeLineBreaks(output)).toEqual(removeLineBreaks(result));
  } catch(e) {
    throw e;
  }
}

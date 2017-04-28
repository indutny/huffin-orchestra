'use strict';

function pad2(num) {
  let res = num.toString();
  while (res.length < 2)
    res = ' ' + res;
  return res;
}
exports.pad2 = pad2;

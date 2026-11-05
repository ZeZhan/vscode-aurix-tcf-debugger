"use strict";
module.exports = validate20;
module.exports.default = validate20;
const schema22 = {"$schema":"http://json-schema.org/draft-07/schema#","properties":{"BitSize":{"type":"integer","minimum":1},"BitOffs":{"type":"integer","minimum":0},"Address":{"type":"number"},"Register":{"type":"string"},"Size":{"type":"number"},"Value":{"type":"string"}},"anyOf":[{"required":["Size"]},{"required":["BitSize"]}],"type":"object"};

function validate20(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
const _errs1 = errors;
let valid0 = false;
const _errs2 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((data.Size === undefined) && (missing0 = "Size")){
const err0 = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
}
var _valid0 = _errs2 === errors;
valid0 = valid0 || _valid0;
if(!valid0){
const _errs3 = errors;
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if((data.BitSize === undefined) && (missing1 = "BitSize")){
const err1 = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
}
var _valid0 = _errs3 === errors;
valid0 = valid0 || _valid0;
}
if(!valid0){
const err2 = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
validate20.errors = vErrors;
return false;
}
else {
errors = _errs1;
if(vErrors !== null){
if(_errs1){
vErrors.length = _errs1;
}
else {
vErrors = null;
}
}
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.BitSize !== undefined){
let data0 = data.BitSize;
const _errs4 = errors;
if(!((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0)))){
validate20.errors = [{instancePath:instancePath+"/BitSize",schemaPath:"#/properties/BitSize/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs4){
if(typeof data0 == "number"){
if(data0 < 1 || isNaN(data0)){
validate20.errors = [{instancePath:instancePath+"/BitSize",schemaPath:"#/properties/BitSize/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.BitOffs !== undefined){
let data1 = data.BitOffs;
const _errs6 = errors;
if(!((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1)))){
validate20.errors = [{instancePath:instancePath+"/BitOffs",schemaPath:"#/properties/BitOffs/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if(typeof data1 == "number"){
if(data1 < 0 || isNaN(data1)){
validate20.errors = [{instancePath:instancePath+"/BitOffs",schemaPath:"#/properties/BitOffs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
var valid1 = _errs6 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.Address !== undefined){
const _errs8 = errors;
if(!(typeof data.Address == "number")){
validate20.errors = [{instancePath:instancePath+"/Address",schemaPath:"#/properties/Address/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
var valid1 = _errs8 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.Register !== undefined){
const _errs10 = errors;
if(typeof data.Register !== "string"){
validate20.errors = [{instancePath:instancePath+"/Register",schemaPath:"#/properties/Register/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid1 = _errs10 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.Size !== undefined){
const _errs12 = errors;
if(!(typeof data.Size == "number")){
validate20.errors = [{instancePath:instancePath+"/Size",schemaPath:"#/properties/Size/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
var valid1 = _errs12 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.Value !== undefined){
const _errs14 = errors;
if(typeof data.Value !== "string"){
validate20.errors = [{instancePath:instancePath+"/Value",schemaPath:"#/properties/Value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid1 = _errs14 === errors;
}
else {
var valid1 = true;
}
}
}
}
}
}
}
else {
validate20.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate20.errors = vErrors;
return errors === 0;
}

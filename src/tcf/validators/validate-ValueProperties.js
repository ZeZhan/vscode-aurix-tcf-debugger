"use strict";
module.exports = validate20;
module.exports.default = validate20;
const schema22 = {"$schema":"http://json-schema.org/draft-07/schema#","definitions":{"PieceValue":{"properties":{"BitSize":{"type":"integer","minimum":1},"BitOffs":{"type":"integer","minimum":0},"Address":{"type":"number"},"Register":{"type":"string"},"Size":{"type":"number"},"Value":{"type":"string"}},"anyOf":[{"required":["Size"]},{"required":["BitSize"]}],"type":"object"}},"properties":{"Address":{"type":"number"},"BigEndian":{"type":"boolean"},"BinaryScale":{"type":"number"},"BitStride":{"type":"number"},"Class":{"enum":[0,1,2,3,4,5,6,7,8,9,10],"type":"number"},"DecimalScale":{"type":"number"},"ImplicitPointer":{"type":"boolean"},"Pieces":{"items":{"$ref":"#/definitions/PieceValue"},"type":"array"},"Register":{"type":"string"},"Symbol":{"type":"string"},"Type":{"type":"string"}},"type":"object"};
const schema23 = {"properties":{"BitSize":{"type":"integer","minimum":1},"BitOffs":{"type":"integer","minimum":0},"Address":{"type":"number"},"Register":{"type":"string"},"Size":{"type":"number"},"Value":{"type":"string"}},"anyOf":[{"required":["Size"]},{"required":["BitSize"]}],"type":"object"};

function validate20(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
if(data.Address !== undefined){
const _errs1 = errors;
if(!(typeof data.Address == "number")){
validate20.errors = [{instancePath:instancePath+"/Address",schemaPath:"#/properties/Address/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
var valid0 = _errs1 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.BigEndian !== undefined){
const _errs3 = errors;
if(typeof data.BigEndian !== "boolean"){
validate20.errors = [{instancePath:instancePath+"/BigEndian",schemaPath:"#/properties/BigEndian/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
return false;
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.BinaryScale !== undefined){
const _errs5 = errors;
if(!(typeof data.BinaryScale == "number")){
validate20.errors = [{instancePath:instancePath+"/BinaryScale",schemaPath:"#/properties/BinaryScale/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.BitStride !== undefined){
const _errs7 = errors;
if(!(typeof data.BitStride == "number")){
validate20.errors = [{instancePath:instancePath+"/BitStride",schemaPath:"#/properties/BitStride/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.Class !== undefined){
let data4 = data.Class;
const _errs9 = errors;
if(!(typeof data4 == "number")){
validate20.errors = [{instancePath:instancePath+"/Class",schemaPath:"#/properties/Class/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
if(!(((((((((((data4 === 0) || (data4 === 1)) || (data4 === 2)) || (data4 === 3)) || (data4 === 4)) || (data4 === 5)) || (data4 === 6)) || (data4 === 7)) || (data4 === 8)) || (data4 === 9)) || (data4 === 10))){
validate20.errors = [{instancePath:instancePath+"/Class",schemaPath:"#/properties/Class/enum",keyword:"enum",params:{allowedValues: schema22.properties.Class.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs9 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.DecimalScale !== undefined){
const _errs11 = errors;
if(!(typeof data.DecimalScale == "number")){
validate20.errors = [{instancePath:instancePath+"/DecimalScale",schemaPath:"#/properties/DecimalScale/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
var valid0 = _errs11 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.ImplicitPointer !== undefined){
const _errs13 = errors;
if(typeof data.ImplicitPointer !== "boolean"){
validate20.errors = [{instancePath:instancePath+"/ImplicitPointer",schemaPath:"#/properties/ImplicitPointer/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
return false;
}
var valid0 = _errs13 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.Pieces !== undefined){
let data7 = data.Pieces;
const _errs15 = errors;
if(errors === _errs15){
if(Array.isArray(data7)){
var valid1 = true;
const len0 = data7.length;
for(let i0=0; i0<len0; i0++){
let data8 = data7[i0];
const _errs17 = errors;
const _errs18 = errors;
const _errs20 = errors;
let valid3 = false;
const _errs21 = errors;
if(data8 && typeof data8 == "object" && !Array.isArray(data8)){
let missing0;
if((data8.Size === undefined) && (missing0 = "Size")){
const err0 = {instancePath:instancePath+"/Pieces/" + i0,schemaPath:"#/definitions/PieceValue/anyOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
}
var _valid0 = _errs21 === errors;
valid3 = valid3 || _valid0;
if(!valid3){
const _errs22 = errors;
if(data8 && typeof data8 == "object" && !Array.isArray(data8)){
let missing1;
if((data8.BitSize === undefined) && (missing1 = "BitSize")){
const err1 = {instancePath:instancePath+"/Pieces/" + i0,schemaPath:"#/definitions/PieceValue/anyOf/1/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
}
var _valid0 = _errs22 === errors;
valid3 = valid3 || _valid0;
}
if(!valid3){
const err2 = {instancePath:instancePath+"/Pieces/" + i0,schemaPath:"#/definitions/PieceValue/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
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
errors = _errs20;
if(vErrors !== null){
if(_errs20){
vErrors.length = _errs20;
}
else {
vErrors = null;
}
}
}
if(errors === _errs18){
if(data8 && typeof data8 == "object" && !Array.isArray(data8)){
if(data8.BitSize !== undefined){
let data9 = data8.BitSize;
const _errs23 = errors;
if(!((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9)))){
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0+"/BitSize",schemaPath:"#/definitions/PieceValue/properties/BitSize/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs23){
if(typeof data9 == "number"){
if(data9 < 1 || isNaN(data9)){
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0+"/BitSize",schemaPath:"#/definitions/PieceValue/properties/BitSize/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
var valid4 = _errs23 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data8.BitOffs !== undefined){
let data10 = data8.BitOffs;
const _errs25 = errors;
if(!((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10)))){
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0+"/BitOffs",schemaPath:"#/definitions/PieceValue/properties/BitOffs/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs25){
if(typeof data10 == "number"){
if(data10 < 0 || isNaN(data10)){
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0+"/BitOffs",schemaPath:"#/definitions/PieceValue/properties/BitOffs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
var valid4 = _errs25 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data8.Address !== undefined){
const _errs27 = errors;
if(!(typeof data8.Address == "number")){
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0+"/Address",schemaPath:"#/definitions/PieceValue/properties/Address/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
var valid4 = _errs27 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data8.Register !== undefined){
const _errs29 = errors;
if(typeof data8.Register !== "string"){
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0+"/Register",schemaPath:"#/definitions/PieceValue/properties/Register/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs29 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data8.Size !== undefined){
const _errs31 = errors;
if(!(typeof data8.Size == "number")){
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0+"/Size",schemaPath:"#/definitions/PieceValue/properties/Size/type",keyword:"type",params:{type: "number"},message:"must be number"}];
return false;
}
var valid4 = _errs31 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data8.Value !== undefined){
const _errs33 = errors;
if(typeof data8.Value !== "string"){
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0+"/Value",schemaPath:"#/definitions/PieceValue/properties/Value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs33 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
}
}
else {
validate20.errors = [{instancePath:instancePath+"/Pieces/" + i0,schemaPath:"#/definitions/PieceValue/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid1 = _errs17 === errors;
if(!valid1){
break;
}
}
}
else {
validate20.errors = [{instancePath:instancePath+"/Pieces",schemaPath:"#/properties/Pieces/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs15 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.Register !== undefined){
const _errs35 = errors;
if(typeof data.Register !== "string"){
validate20.errors = [{instancePath:instancePath+"/Register",schemaPath:"#/properties/Register/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs35 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.Symbol !== undefined){
const _errs37 = errors;
if(typeof data.Symbol !== "string"){
validate20.errors = [{instancePath:instancePath+"/Symbol",schemaPath:"#/properties/Symbol/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs37 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.Type !== undefined){
const _errs39 = errors;
if(typeof data.Type !== "string"){
validate20.errors = [{instancePath:instancePath+"/Type",schemaPath:"#/properties/Type/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs39 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
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

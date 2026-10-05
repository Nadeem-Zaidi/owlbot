# Maximo Application Framework (MAF / Graphite)
### Development Information — June 2022

---

## Table of Contents

- [Declarative UI](#declarative-ui)
- [Layout](#layout)
- [Templates](#templates)
- [Pages and Navigation](#pages-and-navigation)
- [State](#state)
- [Controllers and Events](#controllers-and-events)
- [Datasources](#datasources)
- [Dialogs](#dialogs)
- [Charts](#charts)
- [Localization](#localization)
- [Managing Data on a Page](#managing-data-on-a-page)
- [Application Storage and Deployment](#application-storage-and-deployment)
- [Datasource Overview](#datasource-overview)
- [QBE Filtering](#qbe-filtering)
- [Timeline Queries](#timeline-queries)
- [JavaScript Overview](#javascript-overview)
- [Mobile Supported Flag](#mobile-supported-flag)
- [Dates and Times](#dates-and-times)
- [Drilldown n-levels using Hierarchical Datasources](#drilldown-n-levels-using-hierarchical-datasources)
- [Localization (Language & Locale)](#localization-language--locale)

---

## Declarative UI

Graphite Applications consist of one or more XML files that represent the UI and some JavaScript files used for validation, data manipulation, etc. Every Graphite application follows the following XML structure:

- **Root Element** — usually `application` or `maximo-application`
- **Application State variables** — State shared across pages
- **Application Datasources** — Datasources shared across pages
- **Application Dialogs**
- **Pages Element**
  - Page Element
  - Page State variables
  - Page Datasources — Datasources only used in this page
  - Page components
  - Page Dialogs

All elements use **lowercase and snake-case** element names and attributes.

```xml
<border-layout hidden="true">
  <top background-color="support-01" horizontal-overflow="visible" vertical-overflow="visible">
    <label label="Top"/>
  </top>
</border-layout>
```

Elements and attributes are validated at build time when you run `yarn build`. If you use an invalid element or attribute, the console will show a list of valid options.

### Getting Element Help

```bash
# List all valid elements
yarn man --list

# Get help for a specific element
yarn man button
yarn man tab
```

---

### Properties

All elements have a set of defined properties of a given type or enumeration. If you specify an incorrect property, it will generate an error at build time.

---

### Element IDs

Graphite elements support an `id` property. IDs are used for:

- **Add-on and upgrade cycles** — to determine what has changed in an application
- **Automation testing** — to identify parts of the UI
- **Referencing other parts of the document** — from XML or JavaScript code
- **Automatic generation of ReactJS files** — e.g., `<page id='MyPage'>` might generate `PageMyPage.js`

> **Never change IDs after applications are delivered to a customer** — customers may have customizations that depend on those IDs.

---

### Bindings

A binding is code attached to an attribute of an XML element. Bindings provide:

- Data Formatting
- Data Validation
- Data Updating
- Conditional Expressions

Bindings look like: `attribute="{custom code}"`

#### Two-way Data Binding

Input components such as text inputs and toggles automatically perform two-way data binding.

```xml
<text-input value={page.state.name} />
```

#### Complex Expressions

Bindings support the ternary operator:

```xml
<button label="Create Work Order" hidden="{page.state.canCreateWO || page.state.isAdmin}"/>
<button label="{page.state.currentItem ? page.state.editLabel, page.state.createLabel}"/>
```

#### Binding Keywords

| Keyword | Description |
|---|---|
| `page` | Always refers to the current Page object |
| `app` | Always refers to the global Application object |
| `datasource` | Refers to the currently scoped datasource in repeated components |
| `item` | Refers to the current item being rendered in repeated components |
| `eventManager` | Points to the object closest to handle a given event |

> Graphite bindings implement **automatic null-safe checking**. e.g., `{item.serviceRegion.address.city}` will not cause an error if any object in the chain is null.

---

## Layout

### Box

`box` is similar to a `div` with specific properties to control alignment, color, etc. It arranges content either in a **row** (horizontally) or **column** (vertically).

```xml
<box children-sizes="50,50" direction="row">
  <box background-color="support-03">
    <label label="Row 3 Col 1" />
  </box>
  <box background-color="support-03">
    <label label="Row 3 Col 2" />
  </box>
</box>
```

The `children-sizes` property can simulate a grid by specifying percentage widths for children.

---

### Border Layout

`border-layout` provides a rigid layout contract with 5 distinct areas:

| Area | Description |
|---|---|
| `top` | Above the 3 middle sections, fills horizontally |
| `start` | Below `top`, to the left of `middle` |
| `middle` | Below `top`, between `start` and `end`. Always grows to fill remaining space |
| `end` | Below `top`, to the right of `middle` |
| `bottom` | Below the 3 middle sections, fills horizontally |

All sections are optional and multiple `border-layout` components can be nested.

---

## Templates

### Page Layout

`page-layout` is a template that accepts a `page-header` and `page-footer` docked in the view.

```xml
<page-layout id="r8kv8">
  <page-footer docked="true" id="w6kgb">
    <button label="Footer Button" on-click="{console.log('Button pressed!')}" id="zwqjg"/>
  </page-footer>
</page-layout>
```

---

### Overview

Templates provide a way to create **reusable XML fragments** in your `app.xml`. Templates support:

- Passing parameters
- Slots (just like regular components)

Templates must be defined at the **application level** using the `<templates>` element.

---

### Template Parameters

```xml
<template name="refapp-pivot-row-template" id="wwdjg">
  <template-param name="cols" type="number" required="true" id="bj95b"/>
  <template-param name="label" type="string" required="true" id="verkv"/>
</template>
```

Reference parameters inside the template using `{template.PARAM_NAME}`:

```xml
<box size="{100/template.cols}" hidden="{template.cols<2}">
</box>
```

---

### Template Slots

Slots allow passing complete child content elements into a template:

```xml
<!-- Declare a slot in the template -->
<template-slot name="col1" id="bb745"/>

<!-- Use the slot when calling the template -->
<refapp-pivot-row-template cols="{page.state.templateCols}">
  <label slot="col1" label="Sometext r1 c1" id="kxdp7"/>
</refapp-pivot-row-template>
```

---

### Best Practices for Templates

- **Don't access datasources directly** — use a `datasource` template parameter instead
- **Don't access state directly** — use template parameters and pass state in
- **Create very unique template names** — prefix with your app id and suffix with `-template` (e.g., `refapp-chart-template`)

> A well-defined template should have **no dependencies on your application**.

---

## Pages and Navigation

```xml
<application id="app" product-name="Sample" title="App">
  <menu slot="navigation-items" id="p5jjk">
    <menu-item label="About" icon="carbon:home" page="about" />
    <menu-item label="Controller Demo" icon="carbon:forum" page="controllerDemo" />
  </menu>
  <pages id="main">
    <page id="about">
      ...
    </page>
  </pages>
</application>
```

All pages can be directly routed in the browser URL using `#/PAGEID`. e.g., `#/containers`.

---

### Passing Information Between Pages

```xml
<button label="Details"
  on-click="change-page"
  on-click-arg='{{"name": "details", "params": {"ids": item.wonum}}}'/>
```

From a controller, you can use `app.setCurrentPage()`:

```javascript
showDetails(datasource) {
  let selectedItems = datasource.getSelectedItems();
  let selectedIds = JSON.stringify(selectedItems.map(e => datasource.getId(e)));
  datasource.clearSelections();
  this.app.setCurrentPage({ name: 'details', params: { ids: selectedIds } });
}
```

---

## State

### Application and Page State

State is an important concept — the UI is **only updated based on changes to state**.

```xml
<page>
  <states>
    <state name="button_label" value="Hello" type="string" />
  </states>
  <button label="{page.state.button_label}" on-click="{page.state.button_label='World'}"/>
</page>
```

| Scope | Access |
|---|---|
| Application | `app.state.YOUR_PROPERTY` — accessible from any page |
| Page | `page.state.YOUR_PAGE_PROPERTY` — only accessible on that page |

---

### State and Navigation

Use `url-enabled` to make state changes update the browser URL (enables the back button):

```xml
<states>
  <state name="selectedTabIndex" url-enabled="true" value="0" type="number"/>
</states>
```

---

### List of Application State Variables

```xml
<!-- Disable a button when offline -->
<button label="Submit" disabled="{!app.state.networkConnected}" />

<!-- Hide a table on small screens -->
<box hidden="{app.state.screen.width < 300}">
  <table datasource="ds"/>
</box>

<!-- Hide content on mobile -->
<box hidden="{app.device.isMobile}">
  <table datasource="ds" />
</box>
```

---

## Controllers and Events

Controllers are ES6 JavaScript classes attached to elements like `page`, `application`, and `json-datasource`.

```xml
<json-datasource controller="DataController" id="ds" src="Data.js" />
```

> Events are dispatched to **ALL controllers**. Order is: Datasource → Page → Application.

---

### Named Events

```xml
<button label="Open" on-click="openItem" on-click-arg="{item}" />
```

```javascript
class MyPage {
  openItem(item) {
    if (item.isCancelled) {
      // do something with cancelled item
    } else {
      app.setCurrentPage({ name: 'details', params: { id: item._id } });
    }
  }
}
```

To pass multiple arguments, use a JSON object:

```xml
<button label="Open" on-click="openItem" on-click-arg="{{'datasource': datasource, 'item': item}}" />
```

---

### Events as Expressions

```xml
<!-- Log to console -->
<button on-click="{console.log('clicked')}" />

<!-- Emit a custom event -->
<button on-click="{eventManager.emit('doSomething', item.wonum)}" />
```

> Avoid calling controller methods that return values in expressions — the UI won't update. Instead, bind to **state** and update state in your controller.

---

### Lifecycle Events

#### Application Lifecycle Methods

| Method | Description |
|---|---|
| `applicationInitialized(Application)` | Called once when the app initializes |
| `onContextReceived({context, app})` | Called when the app is launched with a given context |
| `onAppSerialize({app})` | Called when the app is pushed to the background |
| `onAppDeserialize({app})` | Called when the app is restored |

#### Page Lifecycle Methods

| Method | Description |
|---|---|
| `pageInitialized(Page, Application)` | Called once when the page initializes |
| `pageResumed(Page, Application)` | Called every time the page is returned to |
| `pagePaused(Page, Application)` | Called when the page leaves scope |
| `getPageStack(Array<Page>, Page)` | Called on resume/init to allow injecting into the breadcrumb stack |
| `onPageSerialize({page})` | Called when leaving to another application |
| `onPageDeserialize({page})` | Called when resuming from another application |

---

## Datasources

### Using Datasources

A datasource is a data contract between UI components and data. It provides:

- Asynchronous data loading with caching
- Sorting, filtering, searching
- Add / delete / update items with undo stack
- Field warnings and validations
- Selection tracking
- Debounced queries
- Dependency management between datasources

```xml
<json-datasource id="ds" id-attribute="_id" src="test-data.js" controller="DataController" pre-load="false"/>
<table datasource="ds" can-filter="false">
  <table-column name="name" />
  <table-column name="age" />
</table>
```

---

### Data Formatting

Graphite automatically formats data based on the `<schema>` type and the user's locale.

```xml
<field value="{item.amount}"/>
<field value="{item.createddate}"/>
```

---

## Dialogs

Dialogs, Lookups, Flyouts, and Drawers are all defined in the `<dialogs>` section of a `<page>` or `<application>`.

### Dialog

A Dialog shows modal content over a page with primary and secondary action buttons.

```xml
<dialog id="dialog_with_ds" title="Datasource Demo"
  on-primary-action="{console.log('primary action clicked')}"
  primary-action-text="Primary Action"
  on-secondary-action="{console.log('secondary action clicked')}"
  secondary-action-text="Secondary Action">
  <table datasource="dialogds" can-filter="false" id="wypr7">
    <table-column name="name" id="v7y3q"/>
    <table-column name="age" id="qgj2r"/>
  </table>
</dialog>
```

Use `primary-button-disabled` to conditionally disable the primary button:

```xml
<dialog id="complex_dialog" title="Editing 5 Assets"
  primary-button-disabled="{!dsb1.state.canSave}"
  primary-action-text="Save Changes"
  secondary-action-text="Cancel">
</dialog>
```

---

### Flyout

A Flyout is similar to a dialog but shows relative to an anchor position with minimal window decorations.

```xml
<flyout id="flyout_with_ds" modal="false" align="end">
  <table datasource="flyoutds" id="gxzq8">
    <table-column name="name" id="vj7k2"/>
    <table-column name="age" id="ek4r5"/>
  </table>
</flyout>
```

---

### Lookup

A Lookup is a specialized dialog for presenting a selection choice from a datasource.

```xml
<lookup id="testDSLookup" datasource="lookupds"
  on-item-click="{app.toast(`Clicked on `+event.name)}"
  show-search="true"
  lookup-attributes="{['name', 'address']}"
  height="400" width="60">
  <json-datasource id="lookupds" src="test-data-4.js" id-attribute="_id" selection-mode="none"/>
</lookup>
```

---

### Drawer

A Drawer anchors to the start/end of the page and slides in/out.

```xml
<sliding-drawer id="drawer1" align="start" header-text="Start Drawer"
  controller="DialogController"
  on-close-action="{app.toast('Start Drawer Closed')}">
  <box direction="column" id="y8jga">
    ...
  </box>
</sliding-drawer>
```

---

### Opening Dialogs

```xml
<button dialog="dialog_with_ds" label="Open Dialog"/>
<button flyout="flyout_with_ds" label="Open Flyout"/>
<button lookup="testDSLookup" label="Open Lookup"/>
<button drawer="drawer1" label="Open Drawer"/>
```

From controller code:

```javascript
this.app.showDialog('drawer1');
```

---

### Common Dialogs

```javascript
// Show an error
app.error('The record was not saved');

// Show a confirmation
if (await app.prompt('Are you sure?')) {
  this.deleteRecord();
}

// Prompt for text input
let name = await app.prompt('What is your name?');
```

---

### Dialog Lifecycle Events

| Event | Description |
|---|---|
| `dialogInitialized(Dialog)` | Called the first time the dialog is created |
| `dialogOpened(Dialog)` | Called every time the dialog is opened |
| `dialogClosed(Dialog)` | Called every time the dialog is closed |

---

### Checking for Changes on a Sliding Drawer

To prompt users to save changes when closing a drawer, set `useConfirmDialog` on the page:

```xml
<page id="Test" path="test" controller="PageController">
  <states>
    <state name="useConfirmDialog" value="true" type="boolean" />
  </states>
</page>
```

And add `validate-on-exit` to the drawer:

```xml
<sliding-drawer id="docked_drawer1" validate-on-exit="{ddms2}">
</sliding-drawer>
```

---

## Charts

Graphite supports Carbon Charts via `<chart>`. Supported types: `pie`, `bar`, `line`, `line-linear`, `donut`.

### Pie Chart

```xml
<chart type="pie" datasource="{salesds1}" height="400"
  on-segment-click="{app.toast('You clicked ' + arg)}"
  on-segment-click-arg="Pie Segment" id="z8raap">
  <chart-option name="data.groupMapsTo" value="Year" id="r_aa_d7"/>
  <chart-option name="data.valueMapsTo" value="Net Profit" id="gxax2j"/>
  <chart-legend alignment="end" id="am6gek"/>
</chart>
```

### Bar Chart

```xml
<chart type="bar" datasource="{salesds1}" height="400">
  <chart-axis position="bottom" title="Year" data-field="Year"/>
  <chart-axis position="start" title="Net Profit" data-field="Net Profit" scale-type="linear"/>
  <chart-option name="data.groupMapsTo" value="Season"/>
  <chart-toolbar enabled="true"/>
  <chart-legend position="top" orientation="vertical" alignment="end"/>
</chart>
```

### Line Chart

```xml
<chart type="line" height="400" datasource="{stockds1}">
  <chart-option name="data.groupMapsTo" value="Ticker"/>
  <chart-option name="curve" value="curveMonotoneX"/>
  <chart-axis position="bottom" title="Date" data-field="Date" scale-type="time"/>
  <chart-axis position="start" title="Close" data-field="Close" scale-type="linear"/>
</chart>
```

### Donut Chart

```xml
<chart type="donut" datasource="{salesds1}" height="400"
  on-segment-click="{app.toast('You clicked ' + arg)}">
  <chart-option name="data.groupMapsTo" value="Year"/>
  <chart-option name="data.valueMapsTo" value="Net Profit"/>
  <chart-option name="donut.center.label" value="Net Profit"/>
  <chart-toolbar enabled="true"/>
  <chart-legend position="top" alignment="end"/>
</chart>
```

---

## Localization

Graphite applications require minimal effort to support multiple languages. Text in localizable attributes is extracted automatically.

### Creating Localization Files

```bash
npx @maximo/maxdev-cli localize -i ./src/app.xml -o ./src/i18n/labels.json --format json
```

Language files should be named: `labels-LANGCODE.json` (e.g., `labels-fr.json`, `labels-en-gb.json`)

---

### Adding Custom Messages

```xml
<messages>
  <message id="errorMessage" text="We are unable to save at this time. Please try again later."/>
</messages>
```

Reference from JavaScript:

```javascript
app.toast(app.getLocalizedMessage(APPID, 'errorMessage', DEFAULT_VALUE));
```

---

### Generating Mock Localization Files

```bash
# Generate a mock Japanese file
npx @maximo/maxdev-cli localize -i ./src/app.xml -o ./build/app/public/i18n/labels-ja.json --format json --mock ja

# Generate a mock with a custom template
npx @maximo/maxdev-cli localize -i ./src/app.xml -o ./build/app/public/i18n/labels-en-ca.json --format json --mock '[{text} ~~(eh)]'
```

---

## Managing Data on a Page

### Datasource.state.canSave

```xml
<button label="Save data" disabled="{!ds.state.canSave}" />
```

---

### Unsaved Changes Dialog

Enable the confirmation dialog on a page-by-page basis:

```xml
<page id="Test" path="test" controller="PageController">
  <states>
    <state name="useConfirmDialog" value="true" type="boolean" />
  </states>
</page>
```

Toggle programmatically from a controller:

```javascript
toggleConfirmDialog(useConfirmDialog) {
  page.state.useConfirmDialog = useConfirmDialog;
}
```

---

### Using a Custom Save Transition

```javascript
async onCustomSaveTransition(event) {
  // Validation happens here
  return { saveDataSuccessful: true, callDefaultSave: true };
}
```

> The function **must** return an object with `saveDataSuccessful` and `callDefaultSave`.

---

### Marking Items as Required

```xml
<smart-input label="Edit expected life" required="true" id="kn9bm" value="{dsb1.item.expectedLife}"/>
```

---

## Development Best Practices

- **Avoid custom components** — work with the Graphite team to add missing components
- **Use `smart-input` instead of discrete components** like `text-input`
- **Create components that use a Datasource** instead of accepting raw arrays
- **Do not store class instances in the state** — only serializable data (primitives, Arrays, Objects)
- **Use lowercase for maximo datasource attributes** — e.g., `item.status` not `item.STATUS`
- **Never use `app.datasources` or `page.datasources`** — use `app.findDatasource(name)` instead
- **Never use the same event name in multiple controllers** unless you want it handled in each

---

## Application Storage and Deployment

Applications are stored in the `MAFAPPDATA` table with app id, binary file, version, revision, and checksum.

### UpdateDB

Automatically inserts application zip files into the database if they are new. Checks for zipped application binaries in `tools/maximo/en/graphite/apps`.

### Maxdev-cli Upload-app

```bash
npx @maximo/maxdev-cli upload-app -u user -p password -a maxdemo-app
```

Use `--no-context` when uploading to a Maximo server without a context root set.

---

### MAFAPPDATA Insert Rules

| Condition | Result |
|---|---|
| Neither checksum nor version matches | New record created with new version, revision = 0 |
| Checksum matches but version does not | New record created with new version, revision = 0 |
| Version matches but checksum does not | New record created with same version, revision incremented |

---

### Application Deployment

Applications are served from the file system under a `maf/apps` directory. URL format:

```
http://localhost:7001/maximo/oslc/graphite/maxdemo-app
```

Directory naming convention: `MAF/apps/{app id}/{version-revision}`

---

### Application Data Cleanup Cron Task

The `AppDataCleanup` cron task clears stale application data. Configured with `MaxRevisions`:

- If `MaxRevisions = 0`, deleting revisions is disabled
- The cron task **never deletes** the ACTIVE or 0th revision of an application

---

## Datasource Overview

A datasource is a data contract that allows the UI to depend on exposed APIs while delegating actual data loading to implementations.

```xml
<json-datasource id="peopleDS" src="people.js"/>
<field value="{peopleDS.item.firstname}"/>
```

---

### State

Datasources manage stateful properties usable from the declarative UI:

```xml
<!-- Show count of selected items -->
datasource.state.selection.count

<!-- Check if datasource is loading -->
datasource.state.loading

<!-- Check if datasource has data -->
datasource.state.hasData
```

---

### Loading Static Data

```javascript
const data = [
  { _id: 0, name: 'peter', moveddate: '2020-01-31T00:00:00-05:00', address: { city: 'London' } },
  { _id: 1, ... }
];
```

> Dates are always in **ISO 8061 format** with timezone information.

---

### Loading Dynamic Data

```javascript
const loader = async (query) => {
  let itemResp = await fetch('/loadadata');
  return {
    items: await itemResp.json()
  };
};
export default loader;
```

---

### Query

A query is a JSON object that may include:

```javascript
{
  siteid: { value: "BEDFORD" },
  assettype: { operator: "in", value: ["PUMP", "IT"] },
  assethealth: { operator: ">", value: 20 }
}
```

---

### Response

The response object fields:

| Field | Required | Description |
|---|---|---|
| `items` | ✅ | Array of records |
| `total` | ❌ | Total count — tells datasource if more data exists |
| `start` | ❌ | Start index |
| `end` | ❌ | End index |

---

### Reset Datasource State

```xml
<!-- Reset lookup datasource every time it's reopened -->
<lookup id="laborLookup" show-search="true" reset-datasource="true" datasource="laborDs"/>

<!-- Reset datasource when the parent dialog is reopened -->
<maximo-datasource id="laborDs" reset-datasource="true" object-structure="mxapilabor"/>
```

---

### Schema

```xml
<json-datasource id="persons">
  <schema>
    <attribute name="personid" unique-id="true"/>
    <attribute name="displayname" searchable="true" title="Display name" required="true"/>
    <attribute name="firstname" title="First name" remarks="First name of the person"/>
    <attribute name="address.addressline" title="Address line"/>
    <attribute name="address.city" title="City"/>
  </schema>
</json-datasource>
```

---

### Common Datasource APIs

```javascript
// Find a datasource
let ds = app.findDatasource('persons');

// Force reload
ds.forceReload();

// Search
ds.search('Tom', ['displayname']);

// Search with QBE
ds.searchQBE({ age: '>10', updated: '>2020-01-01' });

// Iterate over data
ds.forEach((item) => (totalCost += item.cost));

// Get items
ds.get(0);              // first item
ds.getById('A1000');    // by unique id

// Save changes
ds.save();

// Undo changes
// (call before save when auto-save is false)
```

---

## QBE Filtering

QBE (Query By Example) is a simple API for searching without writing SQL.

### Example QBE Section

```xml
<qbe id="najey">
  <qbe-field name="person" value="WILSON" id="d9m2q"/>
  <qbe-field name="address" value="FRANKLIN" id="nnr2d"/>
  <qbe-field name="age" operator="<" value="50" id="kwa24"/>
</qbe>
```

Generated where clause: `person="WILSON" and address="%FRANKLIN%" and age<50`

---

### QBE Range Queries

```xml
<!-- Integer range -->
<qbe-field name="age" operator=">" value="18" id="q1"/>
<qbe-field name="age" operator="<" value="21" id="q2"/>

<!-- Date range -->
<qbe-field name="birthdate" operator=">" value="1970-01-01T23:59:59" id="q3"/>
<qbe-field name="birthdate" operator="<" value="1980-05-15T00:00:00" id="q4"/>
```

---

### QBE API

```javascript
// Basic QBE
ds.setQBE('startdate', '>=', '2020-10-30');
let items = await ds.searchQBE();

// Range QBE (pass true as 4th parameter)
ds.setQBE('startdate', '>=', '2020-10-30');
ds.setQBE('startdate', '<=', '2020-11-30', true);
let items = await ds.searchQBE();
```

---

## Timeline Queries

A timeline query filters against a field using a relative time (e.g., last 7 days).

### Using Timeline Queries

```javascript
// Apply a timeline query
ds.applyTimelineQuery('last6months', 'createddate');

// With a specific relative date
ds.applyTimelineQuery('last6months', 'createddate', '2021-11-15');

// Ad hoc query
ds.applyTimelineQuery({ query: '-2y' }, 'createddate', '2021-11-15');
```

---

### Timeline Query Format

```
sign number duration
```

Examples:

| Query | Meaning |
|---|---|
| `-7d` | Last 7 days |
| `+7d` | Next 7 days |
| `-6m` | Last 6 months |
| `-2y` | Last 2 years |

---

### Customizing Timelines

```javascript
onDatasourceInitialized(ds) {
  ds.timelineQueries.length = 0; // clear defaults

  ds.registerTimelineQuery({
    id: 'last3months',
    label: 'Last 3 months',
    query: '-3m'
  });

  // Advanced: query as a function
  ds.registerTimelineQuery({
    id: 'lastquarter',
    label: 'Last quarter',
    query: (datasource, queryObject, timelineField) => {
      // custom logic here
    }
  });
}
```

---

## JavaScript Overview

### Async and Await

#### Using async `pageResumed` Lifecycle Method

The `pageResumed` lifecycle method is **not awaited** by the framework. If declared `async`, the code runs after initialization.

**Problematic pattern:**

```javascript
async pageResumed(page, app) {
  page.state.setSomeImportantState = "ABC";
  let ds = app.findDatasource("ds");
  ds.setQBE('wonum', page.params.id);
  await ds.load(); // ❌ runs after first render
}
```

**Correct pattern:**

```javascript
pageResumed(page, app) {
  page.state.setSomeImportantState = "ABC";
  let ds = app.findDatasource("ds");
  ds.setQBE('wonum', page.params.id);
  loadData(); // ✅ non-blocking
}

async loadData() {
  await ds.load();
  page.state.afterDataLoadedSetSomeVar = ds.get(0);
}
```

---

### Show a Page Loading While Waiting for Data

```javascript
async loadData() {
  try {
    this.app.state.pageLoading = true;
    // load data here...
  } finally {
    this.app.state.pageLoading = false;
  }
}
```

---

### async with try / catch / finally

**Incorrect — catch won't work:**

```javascript
pageResumed() {
  try {
    loadData(); // ❌ promise not awaited
  } catch (ex) {
    page.state.error = ex; // never reached
  }
}
```

**Correct — move try/catch inside the async function:**

```javascript
pageResumed() {
  loadData();
}

async loadData() {
  try {
    let items = await this.app.findDatasource('ds').load(); // ✅
  } catch (ex) {
    // error is caught here
  }
}
```

---

### Resolve Promises in Unit Tests

```javascript
// ❌ Wrong — promise is not awaited
it('works', async () => {
  callAsyncMethod();
  await ds.load();
});

// ✅ Correct
it('works', async () => {
  await callAsyncMethod();
  await ds.load();
});
```

---

### Async Functions That Await on Return

**Unnecessary async:**

```javascript
async loadData() {
  let items = await this.app.findDatasource('ds').load();
  return items; // ❌ extra async slice
}
```

**Simplified:**

```javascript
loadData() {
  return this.app.findDatasource('ds').load(); // ✅
}
```

---

## Mobile Supported Flag

Applications can target both Desktop and Mobile. Some components are flagged as `mobile-supported: false`:

- Tables
- Tabs
- Flyouts
- ProgressWizard
- RadioButtons
- PropertiesEditor

Build will fail with an error if unsupported mobile components are used in a mobile application:

```
[ERROR]: The 'tabs' element with id, rnwrk, is not support on a mobile device.
```

---

### How to Flag a Component as Not Supported in Mobile

In the component registry file:

```javascript
const registry = {
  name: 'table',
  description: 'A Table component which displays rows of data.',
  category: 'list',
  'mobile-supported': false,
  ...
};
```

---

## Dates and Times

### Date Field Types

| Type | Description |
|---|---|
| `DATE` | Static date, no timezone conversion. Same date for all users (e.g., Christmas) |
| `TIME` | Time without timezone. Maximo stores in server timezone |
| `DATETIME` | Most common — stores date, time, and timezone. Converts correctly across timezones |
| `DURATION` | Decimal number representing hours (e.g., `1.5` = 1 hour 30 minutes) |

---

### Timezone Scenarios for TIME Fields

**Scenario 1 — Send timezone info:**
Causes different users in different timezones to see different times. ❌

**Scenario 2 — Send timezone on send, strip on view:**
Results in a time that shifts every time it is loaded and saved. ❌

**Scenario 3 — Timezone is ignored (correct approach):**
Strip timezone before sending to Maximo. All users see the same time. ✅

> For `DATE` and `TIME` fields: **always strip timezone information** before sending to Maximo.

> For `DATETIME` fields: **always include timezone** — Maximo will convert correctly.

---

## Drilldown n-levels using Hierarchical Datasources

### Maximo-Datasource Properties

```xml
<!-- Setup #1: Basic hierarchy using syschildren -->
<maximo-datasource id="ddLocationDS1" object-structure="mxapioperloc" pre-load="true">
  <schema id="dmg3k">
    <attribute name="location" searchable="true" id="yya3k"/>
    <attribute name="description" searchable="true" id="q88jn"/>
    <attribute name="locations" child-relationship="syschildren" id="xrprg"/>
  </schema>
</maximo-datasource>

<!-- Setup #2: Apply parent saved-query to all children -->
<maximo-datasource id="ddLocationDS1" saved-query="SERVICEREQUESTLOCATION" object-structure="mxapioperloc">
  <schema id="dmg3k">
    <attribute name="locations" child-relationship="syschildren" use-saved-query="true" id="xrprg"/>
  </schema>
</maximo-datasource>

<!-- Setup #3: Different query for children -->
<maximo-datasource id="ddLocationDS1" saved-query="SERVICEREQUESTROOTLOCATION" object-structure="mxapioperloc">
  <schema id="dmg3k">
    <attribute name="locations" child-relationship="syschildren" child-saved-query="SERVICEREQUESTLOCATION" id="xrprg"/>
  </schema>
</maximo-datasource>

<!-- Setup #4: With ctx filter for systems -->
<maximo-datasource id="ddLocationDS1" ctx="systemid=PRIMARY" saved-query="SERVICEREQUESTROOTLOCATION" object-structure="mxapioperloc">
  <schema id="dmg3k">
    <attribute name="locations" child-relationship="syschildren" child-saved-query="SERVICEREQUESTLOCATION" id="xrprg"/>
  </schema>
</maximo-datasource>
```

---

### Datalist Setup

```xml
<data-list datasource="ddLocationDS1" width="100" show-search="false"
  tree-name="Location Tree" title="Locations" hierarchy-drill-in="true" id="bk_5r">
  <!-- Child level -->
  <list-item child-attribute="locations" id="pj32_">
    <container display="flex" id="z2nn_">
      <label label="{item.location}" id="em6yw"/>
    </container>
  </list-item>
  <!-- Top level -->
  <list-item id="b8v7g">
    ...
  </list-item>
</data-list>
```

---

### Child-Data Filtering

Use `maximo-child-filter` to filter, sort, or limit related child data sets:

```xml
<maximo-datasource id="p2wo" object-structure="mxapiwodetail">
  <schema id="myy27">
    <attribute name="rel.woactivtiy{wonum,description,status}" id="nbmw5">
      <maximo-child-filter
        related-path="workorder.woactivity"
        limit="3"
        order-by="-wonum"
        where="status=&quot;WAPPR&quot;"
        id="wk27j"/>
    </attribute>
  </schema>
</maximo-datasource>
```

> `maximo-child-filter` is **not allowed** within nested child attributes — only within top-level attributes.

---

## Localization (Language & Locale)

### Determining Language

The process for determining which language is used depends on the platform:

| Platform | Locale Source |
|---|---|
| Maximo Application (EAM Server) | Maximo UserInfo locale |
| MAS Application | MAS Profile locale |
| Browser Platform | Browser locale (`navigator.language`) |
| Mobile Container | Mobile OS locale |

> If the browser URL contains `lang=aa_BB`, that locale overrides the profile setting.

### Mock Localization Testing

Append `_graphite_mock` to the URL to test localization:

```
?_graphite_mock=ja   (Japanese)
?_graphite_mock=de   (German)
```

Labels appear prefixed like: `[(')一構ソチ‐ User Name]`

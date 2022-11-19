const {Salesforce} = require('./salesforce');

// test('getLeadOrContact', () => {
//     const salesforce = new Salesforce('sandbox');
//     salesforce.getLeadOrContact('ericmueller99@gmail.com')
//         .then(data => {
//             console.log(data);
//         })
//         .catch(error => {
//             console.log(error);
//         })
// })

getLeadOrContact = () => {
    const salesforce = new Salesforce('sandbox');
    salesforce.getLeadOrContact('ericmueller99@gmail.com')
        .then(data => {
            console.log(data);
        })
        .catch(error => {
            console.log(error)
        })
}
// getLeadOrContact();


// (() => {
//
//     const query = `SELECT Id, FirstName, LastName, Email, Phone, LeadSource,
//                     Lead_Source_Detail__c, Status, LastActivityDate, LastModifiedDate,
//                     IsConverted, ConvertedDate, CreatedBy.Email, ConvertedContactId
//                     FROM Lead
//                     WHERE LastModifiedDate >= 1999-01-01T23:01:01-08:00
//                     ORDER BY LastActivityDate DESC, LastModifiedDate DESC`
//
//     const salesforce = new Salesforce('production', {username: 'it@hollyburn.com', password: 'EA1q3v@cp9SFF!Mj<^##', loginUrl: 'https://login.salesforce.com'});
//     salesforce.getRecordsFromSOQLBulk(query)
//     .then(data => {
//         console.log(data.length);
//         console.log(data);
//     })
//     .catch(error => {
//         console.log(error);
//     });
//
//
// })()


//test bulk.query without jsforce since it's being buggy and not emitting events properly.
(() => {

    const query = `SELECT Id, FirstName, LastName, Email, Phone, LeadSource, Lead_Source_Detail__c, Status, LastActivityDate, LastModifiedDate FROM Lead`;
    const salesforce = new Salesforce('production', {username: 'it@hollyburn.com', password: 'L4XP>80V@Ib$Qn<Yyle5',
        loginUrl: 'https://login.salesforce.com',
        clientSecret: '5D1F570DFF500801AE686C9561703DE36D7DA418CBC3D5DA0F6557DDB13289F3', clientId: '3MVG9g9rbsTkKnAX0YNwvb0z0TMcE2A.aT5fJsmn4ICAWttJzeQOYHA5JIsw3RMokdksFaGLGMMghwOwLPQFn'});
    salesforce.getRecordsFromSOQLBulk(query)
    .then(res => {
        console.log('done overall!')
        console.log(res);
    })
    .catch(error => {
        console.log(error);
    });


})()
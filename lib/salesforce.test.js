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


(() => {

    const query = `SELECT Id, FirstName, LastName, Email, Phone, LeadSource,
                    Lead_Source_Detail__c, Status, LastActivityDate, LastModifiedDate,
                    IsConverted, ConvertedDate, CreatedBy.Email, ConvertedContactId
                    FROM Lead
                    WHERE LastModifiedDate >= 1999-01-01T23:01:01-08:00
                    ORDER BY LastActivityDate DESC, LastModifiedDate DESC`

    const salesforce = new Salesforce('production', {username: 'it@hollyburn.com', password: 'EA1q3v@cp9SFF!Mj<^##', loginUrl: 'https://login.salesforce.com'});
    salesforce.getRecordsFromSOQLBulk(query)
    .then(data => {
        console.log(data.length);
        console.log(data);
    })
    .catch(error => {
        console.log(error);
    });


})()